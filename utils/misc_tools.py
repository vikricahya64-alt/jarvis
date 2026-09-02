"""
Miscellaneous agentic tools that need no API key (or reuse the existing
Groq key): weather, currency conversion, crypto prices, IP/geo lookup,
URL shortening, translation, and world-clock time. All synchronous httpx
calls so they fit inside Vercel serverless. Every function returns a plain
dict (never raises) so the orchestrator loop can keep going.
"""
import os
import ast
import math
import operator
import httpx
import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_TIMEOUT = httpx.Timeout(15)

# Small weather-code -> description map (WMO codes, Open-Meteo style).
_WEATHERCODES = {
    0: "cerah", 1: "cerah berawan", 2: "berawan sebagian", 3: "mendung",
    45: "berkabut", 48: "berkabut (ada embun beku)",
    51: "gerimis ringan", 53: "gerimis", 55: "gerimis deras",
    61: "hujan ringan", 63: "hujan", 65: "hujan deras",
    71: "salju ringan", 73: "salju", 75: "salju deras",
    80: "hujan gerimis", 81: "hujan", 82: "hujan lebat",
    95: "badai petir", 96: "badai petir + hujan es", 99: "badai petir parah",
}


def _ok(data: dict) -> dict:
    data.setdefault("success", True)
    return data


def _err(message: str) -> dict:
    return {"success": False, "error": message[:400]}


# ------------------------------------------------------------------
# Weather (Open-Meteo, no key)
# ------------------------------------------------------------------
def get_weather(city: str) -> dict:
    """Current weather + today's forecast for a city (Open-Meteo, free)."""
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            geo = client.get(
                "https://geocoding-api.open-meteo.com/v1/search",
                params={"name": city, "count": 1},
            )
            geo.raise_for_status()
            matches = (geo.json() or {}).get("results") or []
            if not matches:
                return _err(f"Lokasi '{city}' tidak ditemukan.")
            g = matches[0]
            f = client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": g["latitude"], "longitude": g["longitude"],
                    "current_weather": "true",
                    "daily": "temperature_2m_max,temperature_2m_min,"
                             "precipitation_probability_max,weathercode",
                    "timezone": "auto", "forecast_days": "1",
                },
            )
            f.raise_for_status()
            d = f.json()
            cur = d.get("current_weather") or {}
            day = (d.get("daily") or {})
        place = f"{g.get('name', city)}, {g.get('country', '')}".strip(", ")
        desc = _WEATHERCODES.get(cur.get("weathercode"), "tidak diketahui")
        precip = (day.get("precipitation_probability_max") or [None])[0]
        precip = f"{precip}%" if precip is not None else "n/a"
        return _ok({
            "place": place,
            "description": desc,
            "temperature_celsius": cur.get("temperature"),
            "windspeed_kmh": cur.get("windspeed"),
            "today_min_celsius": (day.get("temperature_2m_min") or [None])[0],
            "today_max_celsius": (day.get("temperature_2m_max") or [None])[0],
            "rain_probability": precip,
        })
    except httpx.HTTPError as exc:
        return _err(f"Jaringan gagal menghubungi Open-Meteo: {exc}")


# ------------------------------------------------------------------
# Currency (open.er-api.com, no key)
# ------------------------------------------------------------------
def convert_currency(amount: float, from_currency: str, to_currency: str) -> dict:
    """Convert amount between ISO currencies using free base-USD rates."""
    try:
        amount = float(amount)
        src = (from_currency or "USD").upper()
        dst = (to_currency or "IDR").upper()
        with httpx.Client(timeout=_TIMEOUT) as client:
            r = client.get("https://open.er-api.com/v6/latest/USD")
            r.raise_for_status()
            body = r.json()
            rates = body.get("rates") or {}
        if body.get("result") != "success":
            return _err("Layanan kurs sedang tidak tersedia.")
        if src not in rates or dst not in rates:
            return _err(f"Kode mata uang tidak dikenal: {src}/{dst}. "
                        f"Contoh: USD, IDR, EUR, SGD.")
        converted = amount * rates[dst] / rates[src]
        return _ok({
            "amount": amount, "from": src, "to": dst,
            "rate": round(rates[dst] / rates[src], 6),
            "result": f"{amount:,.2f} {src} = {converted:,.2f} {dst}",
        })
    except (ValueError, TypeError):
        return _err(f"Jumlah tidak valid: {amount!r}")
    except httpx.HTTPError as exc:
        return _err(f"Jaringan gagal menghubungi layanan kurs: {exc}")


# ------------------------------------------------------------------
# Crypto prices (CoinGecko, no key)
# ------------------------------------------------------------------
_COIN_ALIASES = {
    "btc": "bitcoin", "bitcoin": "bitcoin", "eth": "ethereum",
    "ethereum": "ethereum", "sol": "solana", "solana": "solana",
    "doge": "dogecoin", "dogecoin": "dogecoin", "shib": "shiba-inu",
    "xrp": "ripple", "ripple": "ripple", "ada": "cardano",
    "cardano": "cardano", "dot": "polkadot", "polkadot": "polkadot",
    "ltc": "litecoin", "litecoin": "litecoin", "bnb": "binancecoin",
    "matic": "matic-network", "polygon": "matic-network",
    "avax": "avalanche-2", "ton": "the-open-network", "trx": "tron",
    "link": "chainlink", "atom": "cosmos", "near": "near",
    "xlm": "stellar", "apt": "aptos", "arb": "arbitrum",
    "matic-network": "matic-network",
}


def crypto_price(coin: str, currency: str = "usd") -> dict:
    """Current price of a crypto coin (CoinGecko)."""
    try:
        cur = (currency or "usd").lower()
        key = (coin or "").strip().lower()
        cg_id = _COIN_ALIASES.get(key)
        with httpx.Client(timeout=_TIMEOUT) as client:
            if not cg_id:
                s = client.get(
                    "https://api.coingecko.com/api/v3/search",
                    params={"query": key},
                )
                s.raise_for_status()
                matches = (s.json() or {}).get("coins") or []
                if not matches:
                    return _err(f"Koin kripto '{coin}' tidak ditemukan.")
                cg_id = matches[0]["id"]
            r = client.get(
                "https://api.coingecko.com/api/v3/simple/price",
                params={"ids": cg_id, "vs_currencies": cur.lower()},
            )
            r.raise_for_status()
            price = (r.json() or {}).get(cg_id, {}).get(cur)
        if price is None:
            return _err(f"Kurrency '{currency}' tidak didukung.")
        return _ok({
            "coin": cg_id, "currency": cur,
            "price": price,
            "result": f"{price:,.{4 if price < 1 else 2}f} {cur.upper()}",
        })
    except httpx.HTTPError as exc:
        return _err(f"Jaringan gagal menghubungi CoinGecko: {exc}")


# ------------------------------------------------------------------
# IP / geo lookup (ipapi.co, no key)
# ------------------------------------------------------------------
def geo_info(ip: str = "") -> dict:
    """Look up IP or caller's own IP -> city/region/country/org."""
    try:
        url = f"https://ipapi.co/{ip}/json/" if ip else "https://ipapi.co/json/"
        with httpx.Client(timeout=_TIMEOUT) as client:
            r = client.get(url)
            r.raise_for_status()
            d = r.json()
        if d.get("error") or not d.get("ip"):
            return _err(d.get("reason") or "IP tidak bisa di-resolve.")
        return _ok({
            "ip": d.get("ip"), "city": d.get("city"),
            "region": d.get("region"), "country": d.get("country_name"),
            "latitude": d.get("latitude"), "longitude": d.get("longitude"),
            "timezone": d.get("timezone"), "org": d.get("org"),
        })
    except httpx.HTTPError as exc:
        return _err(f"Jaringan gagal menghubungi ipapi.co: {exc}")


# ------------------------------------------------------------------
# Short URL (is.gd, fallback tinyurl, no key)
# ------------------------------------------------------------------
def shorten_url(url: str) -> dict:
    """Shorten a long URL via is.gd (falls back to TinyURL)."""
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            r = client.get(
                "https://is.gd/create.php",
                params={"format": "json", "url": url},
                follow_redirects=True,
            )
            try:
                d = r.json()
            except Exception:
                d = {}
            if d.get("shorturl"):
                return _ok({"original": url, "short_url": d["shorturl"]})
            # fallback
            t = client.get(
                "https://tinyurl.com/api-create.php", params={"url": url}
            )
            short = t.text.strip()
            if t.status_code == 200 and short.startswith("http"):
                return _ok({"original": url, "short_url": short,
                            "via": "tinyurl"})
        return _err("Tidak bisa memperpendek URL tersebut.")
    except Exception as exc:
        return _err(f"Shorten gagal: {exc}")


# ------------------------------------------------------------------
# Translation (via Groq LLM, reuses existing key)
# ------------------------------------------------------------------
def translate(text: str, target_lang: str = "id") -> dict:
    """Translate text into a target language using the Groq LLM."""
    from utils import groq_client
    lang = (target_lang or "id").strip()
    if not text:
        return _err("Teks kosong.")
    try:
        response = groq_client.sync_completion(
            text,
            system_prompt=(
                "You are a translator. Detect the source language automatically "
                f"and translate the user's text into {lang}. Return ONLY the "
                "translation, no quotes, no explanation, no additional text."
            ),
            tool_choice="none",
        )
        translated = (response.choices[0].message.content or "").strip()
        if not translated:
            return _err("Penerjemahan menghasilkan teks kosong.")
        return _ok({"source_text": text[:2000], "translation": translated})
    except Exception as exc:
        return _err(f"Penerjemahan gagal: {exc}")


# ------------------------------------------------------------------
# World clock (stdlib zoneinfo, no network)
# ------------------------------------------------------------------
_TIMEZONE_ALIASES = {
    "jakarta": "Asia/Jakarta", "wib": "Asia/Jakarta", "indonesia": "Asia/Jakarta",
    "makassar": "Asia/Makassar", "wita": "Asia/Makassar",
    "jayapura": "Asia/Jayapura", "wit": "Asia/Jayapura", "papua": "Asia/Jayapura",
    "sydney": "Australia/Sydney", "melbourne": "Australia/Melbourne",
    "london": "Europe/London", "paris": "Europe/Paris", "berlin": "Europe/Berlin",
    "rome": "Europe/Rome", "madrid": "Europe/Madrid", "amsterdam": "Europe/Amsterdam",
    "moscow": "Europe/Moscow", "new york": "America/New_York",
    "los angeles": "America/Los_Angeles", "san francisco": "America/Los_Angeles",
    "chicago": "America/Chicago", "denver": "America/Denver",
    "tokyo": "Asia/Tokyo", "seoul": "Asia/Seoul", "singapore": "Asia/Singapore",
    "kuala lumpur": "Asia/Kuala_Lumpur", "bangkok": "Asia/Bangkok",
    "hong kong": "Asia/Hong_Kong", "beijing": "Asia/Shanghai",
    "shanghai": "Asia/Shanghai", "dubai": "Asia/Dubai", "india": "Asia/Kolkata",
    "delhi": "Asia/Kolkata", "mumbai": "Asia/Kolkata",
    "hawaii": "Pacific/Honolulu", "auckland": "Pacific/Auckland",
}


def world_time(zone: str = "") -> dict:
    """Current local time for a zone name/alias, or Jakarta by default."""
    key = (zone or "").strip().lower().replace("_", " ")
    tz_name = _TIMEZONE_ALIASES.get(key) or key
    try:
        tz = ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        return _err(
            f"Zona waktu '{zone or 'default'}' tidak dikenal. "
            "Contoh: jakarta, tokyo, london, new york, sydney."
        )
    now = datetime.datetime.now(tz)
    offset = now.utcoffset() or datetime.timedelta(0)
    off_h, off_m = divmod(int(offset.total_seconds()) // 60, 60)
    sign = "+" if offset.total_seconds() >= 0 else "-"
    return _ok({
        "zone": str(tz),
        "local_time": now.strftime("%Y-%m-%d %H:%M"),
        "weekday": now.strftime("%A"),
        "utc_offset": f"{sign}{abs(off_h):02d}:{abs(off_m):02d}",
        "utc_now": datetime.datetime.now(datetime.timezone.utc)
        .strftime("%Y-%m-%d %H:%M UTC"),
    })


# ------------------------------------------------------------------
# Safe calculator (pure Python AST, no network)
# ------------------------------------------------------------------
_CALC_BINOPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod, ast.Pow: operator.pow,
    ast.BitAnd: operator.and_, ast.BitOr: operator.or_,
    ast.BitXor: operator.xor, ast.LShift: operator.lshift,
    ast.RShift: operator.rshift,
}
_CALC_UNARYOPS = {ast.UAdd: operator.pos, ast.USub: operator.neg,
                  ast.Invert: operator.invert}
_CALC_NAMES = {
    "pi": math.pi, "e": math.e, "tau": math.tau,
    "sqrt": math.sqrt, "abs": abs, "round": round, "min": min, "max": max,
    "floor": math.floor, "ceil": math.ceil, "sin": math.sin, "cos": math.cos,
    "tan": math.tan, "log": math.log, "log10": math.log10, "exp": math.exp,
    "degrees": math.degrees, "radians": math.radians,
}


def _calc_eval(node):
    if isinstance(node, ast.Expression):
        return _calc_eval(node.body)
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.BinOp):
        op = _CALC_BINOPS.get(type(node.op))
        if op is None:
            raise ValueError(f"operator tidak didukung: {type(node.op).__name__}")
        return op(_calc_eval(node.left), _calc_eval(node.right))
    if isinstance(node, ast.UnaryOp):
        op = _CALC_UNARYOPS.get(type(node.op))
        if op is None:
            raise ValueError(f"operator tidak didukung: {type(node.op).__name__}")
        return op(_calc_eval(node.operand))
    if isinstance(node, ast.Name):
        if node.id in _CALC_NAMES:
            return _CALC_NAMES[node.id]
        raise ValueError(f"konstanta/fungsi tidak dikenal: {node.id}")
    if isinstance(node, ast.Call):
        fn = _CALC_NAMES.get(node.func.id) if isinstance(node.func, ast.Name) else None
        if fn is None:
            raise ValueError("hanya fungsi aritmatika dasar yang diizinkan")
        args = [_calc_eval(a) for a in node.args]
        return fn(*args)
    raise ValueError(f"ekspresi tidak didukung: {type(node).__name__}")


def calculate(expression: str) -> dict:
    """Evaluate a math expression safely (no exec/eval of arbitrary code)."""
    try:
        tree = ast.parse((expression or "").strip(), mode="eval")
        value = _calc_eval(tree)
        if isinstance(value, float):
            result = f"{value:,.12g}"
        else:
            result = str(value)
        return _ok({"expression": (expression or "").strip(),
                    "value": value, "result": result})
    except (SyntaxError, ValueError, TypeError, ZeroDivisionError) as exc:
        return _err(f"Perhitungan gagal: {exc}")


# ------------------------------------------------------------------
# Unit converter (pure Python, no network)
# ------------------------------------------------------------------
# Normalized aliases -> (kind, factor to base, base name)
_UNITS = {
    # length -> base meter
    "m": ("length", 1, "meter"), "meter": ("length", 1, "meter"),
    "meters": ("length", 1, "meter"), "metre": ("length", 1, "meter"),
    "km": ("length", 1000, "meter"), "kilometer": ("length", 1000, "meter"),
    "kilometers": ("length", 1000, "meter"),
    "cm": ("length", 0.01, "meter"), "centimeter": ("length", 0.01, "meter"),
    "mm": ("length", 0.001, "meter"), "millimeter": ("length", 0.001, "meter"),
    "in": ("length", 0.0254, "meter"), "inch": ("length", 0.0254, "meter"),
    "ft": ("length", 0.3048, "meter"), "foot": ("length", 0.3048, "meter"),
    "yd": ("length", 0.9144, "meter"), "yard": ("length", 0.9144, "meter"),
    "mile": ("length", 1609.344, "meter"), "mi": ("length", 1609.344, "meter"),
    # mass -> base gram
    "g": ("mass", 1, "gram"), "gram": ("mass", 1, "gram"),
    "kg": ("mass", 1000, "gram"), "kilogram": ("mass", 1000, "gram"),
    "mg": ("mass", 0.001, "gram"), "milligram": ("mass", 0.001, "gram"),
    "lb": ("mass", 453.59237, "gram"), "pound": ("mass", 453.59237, "gram"),
    "oz": ("mass", 28.349523, "gram"), "ounce": ("mass", 28.349523, "gram"),
    "ton": ("mass", 1e6, "gram"), "tonne": ("mass", 1e6, "gram"),
    # speed -> base m/s
    "m/s": ("speed", 1, "m/s"), "km/h": ("speed", 1 / 3.6, "m/s"),
    "kmh": ("speed", 1 / 3.6, "m/s"), "kph": ("speed", 1 / 3.6, "m/s"),
    "mph": ("speed", 0.44704, "m/s"), "knot": ("speed", 0.514444, "m/s"),
    "kn": ("speed", 0.514444, "m/s"),
    # data -> base byte
    "b": ("data", 1, "byte"), "byte": ("data", 1, "byte"),
    "kb": ("data", 1000, "byte"), "kilobyte": ("data", 1000, "byte"),
    "mb": ("data", 1e6, "byte"), "megabyte": ("data", 1e6, "byte"),
    "gb": ("data", 1e9, "byte"), "gigabyte": ("data", 1e9, "byte"),
    "tb": ("data", 1e12, "byte"), "terabyte": ("data", 1e12, "byte"),
    "kib": ("data", 1024, "byte"), "kibibyte": ("data", 1024, "byte"),
    "mib": ("data", 1048576, "byte"), "mebibyte": ("data", 1048576, "byte"),
    "gib": ("data", 1073741824, "byte"),
}


def convert_units(value: float, from_unit: str, to_unit: str) -> dict:
    """Convert between length/mass/speed/data units; temperature uses (c,f,k)."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return _err(f"Nilai tidak valid: {value!r}")

    src = (from_unit or "").strip().lower().replace(" ", "")
    dst = (to_unit or "").strip().lower().replace(" ", "")

    # Temperature is affine, handle separately.
    temp_aliases = {"c": "c", "celsius": "c", "f": "f", "fahrenheit": "f",
                    "k": "k", "kelvin": "k"}
    if src in temp_aliases and dst in temp_aliases:
        c = f = k = None
        u = temp_aliases[src]
        if u == "c":
            c = v
        elif u == "f":
            c = (v - 32) * 5 / 9
        else:
            c = v - 273.15
        f = c * 9 / 5 + 32
        k = c + 273.15
        labels = {"c": "°C", "f": "°F", "k": "K"}
        out = {"c": c, "f": f, "k": k}[temp_aliases[dst]]
        return _ok({
            "from": f"{v} {src}", "to": f"{out:,.4g} {labels[temp_aliases[dst]]}",
            "result": f"{v:,.4g} {src} = {out:,.4g} {labels[temp_aliases[dst]]}",
        })

    if src in temp_aliases or dst in temp_aliases:
        return _err("Campuran suhu dan satuan lain tidak bisa dikonversi.")

    su = _UNITS.get(src)
    du = _UNITS.get(dst)
    if su is None or du is None:
        return _err(
            f"Satuan tidak dikenal: '{from_unit}' / '{to_unit}'. "
            "Contoh: km, mile, kg, lb, km/h, mph, mb, gb, c, f."
        )
    if su[0] != du[0]:
        return _err(f"Jenis satuan berbeda: {su[2]} vs {du[2]}.")
    out = v * su[1] / du[1]
    return _ok({
        "from": f"{v:,.4g} {src}", "to": f"{out:,.4g} {dst}",
        "result": f"{v:,.4g} {src} = {out:,.4g} {dst}",
    })


# ------------------------------------------------------------------
# QR code (via E2B sandbox -> PNG artifact)
# ------------------------------------------------------------------
def make_qr(data: str) -> dict:
    """Generate a QR code PNG for arbitrary data using an E2B sandbox."""
    from utils.e2b_executor import execute_code
    if not (data or "").strip():
        return _err("Data QR kosong.")
    code = (
        "import qrcode\n"
        "qr = qrcode.QRCode(border=2)\n"
        f"qr.add_data({data!r})\n"
        "qr.make(fit=True)\n"
        "img = qr.make_image(fill_color='black', back_color='white')\n"
        "img.save('/home/user/qr_code.png')\n"
        "print('saved')"
    )
    result = execute_code(code, "python")
    if not result.get("success"):
        return _err(result.get("stderr") or "E2B gagal membuat QR.")
    return _ok({"data": data, "files": result.get("files", []),
                "note": "File QR siap diunggah."})