"""
Direct command handlers (no LLM, no Groq, no task DB row).

Commands are routed from webhook.py before the agentic pipeline, making
them instant and TPM-free. Returns True if handled (caller should return
immediately), False if not a recognized command.
"""
import datetime
from zoneinfo import ZoneInfo

from utils import supabase_client, todos, telegram
from utils.misc_tools import (
    world_time, get_weather, geo_info,
    convert_currency, crypto_price,
)
from utils.search_tools import search_live as _search_live
from utils.documents import store_document, retrieve_docs
from utils.supabase_client import _config, _auth_headers
import httpx

_BOT_NAME = "J.A.R.V.I.S."

_HELP = (
    "Halo! Saya {name}, asisten AI Anda.\n\n"
    "Perintah langsung (tanpa AI):\n"
    "/todo — daftar todo dengan tombol interaktif\n"
    "/add <tugas> — tambah todo\n"
    "/done <nomor/teks> — tandai selesai\n"
    "/hapus <nomor/teks> — hapus todo\n"
    "/status — status bot & statistik\n"
    "/waktu [zona] — jam sekarang\n"
    "/cuaca <kota> — cuaca saat ini\n"
    "/ip [alamat] — info lokasi IP\n"
    "/kurs <dari> <ke> — konversi mata uang\n"
    "/kripto <simbol> — harga koin (contoh: /kripto BTC)\n"
    "/ingat <judul>: <isi> — simpan catatan\n"
    "/cari <query> — pencarian web langsung\n"
    "/ringkas <url> — ringkas halaman web\n\n"
    "Kirim pesan suara 🎤 — saya ubah jadi teks & jawab.\n"
    "Kirim foto 🖼 — saya analisis: deskripsi, baca teks, jawab pertanyaan "
    "lewat caption.\n"
    "Kirim dokumen 📄 — saya baca .txt/.md/.csv/.json & juga PDF/DOCX/XLSX.\n"
    "Ketik pesan biasa untuk bicara dengan saya lewat AI."
).format(name=_BOT_NAME)


def handle_command(chat_id: int, text: str, telegram_id: int) -> bool:
    """Route a /command. Returns True if handled (caller should stop)."""
    parts = text.strip().split(maxsplit=1)
    cmd = parts[0].lower().split("@")[0]
    args = parts[1].strip() if len(parts) > 1 else ""

    TABLE = {
        "/start": _cmd_start,
        "/help": _cmd_start,
        "/todo": _cmd_todo,
        "/add": _cmd_add,
        "/done": _cmd_done,
        "/hapus": _cmd_hapus,
        "/status": _cmd_status,
        "/waktu": _cmd_waktu,
        "/cuaca": _cmd_cuaca,
        "/ip": _cmd_ip,
        "/kurs": _cmd_kurs,
        "/kripto": _cmd_kripto,
        "/ingat": _cmd_ingat,
        "/cari": _cmd_cari,
        "/search": _cmd_cari,
        "/ringkas": _cmd_ringkas,
        "/jadwal": _cmd_jadwal,
        "/listjadwal": _cmd_list_jadwal,
        "/hapusjadwal": _cmd_hapus_jadwal,
        "/initautonomi": _cmd_init_autonomi,
        "/login": _cmd_login,
        "/logoutprov": _cmd_logout_provider,
    }
    handler = TABLE.get(cmd)
    if not handler:
        return False
    try:
        handler(chat_id, telegram_id, args)
    except Exception as exc:
        telegram.send_message(chat_id, f"Error: {exc}")
    return True


def handle_callback(chat_id: int, callback_id: str, data: str,
                    telegram_id: int) -> bool:
    """Handle inline-keyboard callback. Returns True if handled."""
    parts = data.split(":", 2)
    if len(parts) < 3 or parts[0] != "td":
        return False
    action, item_id = parts[1], parts[2]
    if action == "done":
        res = todos.done_todo(telegram_id, item_id)
        telegram.answer_callback_query(callback_id,
                                       "✅ Selesai" if res.get("success")
                                       else res.get("error", "Gagal"))
    elif action == "del":
        res = todos.remove_todo(telegram_id, item_id)
        telegram.answer_callback_query(callback_id,
                                       "🗑 Dihapus" if res.get("success")
                                       else res.get("error", "Gagal"))
    else:
        return False
    # Refresh the message with updated list.
    text, markup = todos.render_todo_keyboard(telegram_id)
    telegram.edit_message(chat_id, _callback_message_id(callback_id),
                          text, markup)
    return True


# Telegram doesn't put message_id in callback_query; we need to use
# callback_query.message.message_id.
_callback_message_id_cache = {}


def _cache_callback_message(callback_id: str, message_id: int):
    _callback_message_id_cache[callback_id] = message_id


def _callback_message_id(callback_id: str) -> int:
    return _callback_message_id_cache.pop(callback_id, 0)


# ------------------------------------------------------------------
# Individual command handlers
# ------------------------------------------------------------------
def _cmd_start(chat_id, tid, args):
    telegram.send_message(chat_id, _HELP)


def _cmd_todo(chat_id, tid, args):
    text, markup = todos.render_todo_keyboard(tid)
    telegram.send_message_keyboard(chat_id, text, markup)


def _cmd_add(chat_id, tid, args):
    if not args:
        return telegram.send_message(chat_id, "Tulis tugas: /add beli susu")
    res = todos.add_todo(tid, args)
    if res.get("success"):
        if res.get("note"):
            telegram.send_message(chat_id, f"ℹ️ {res['note']}")
        else:
            telegram.send_message(chat_id, f"✅ Ditambahkan: {args}")
    else:
        telegram.send_message(chat_id, f"❌ {res.get('error', 'Gagal')}")



def _cmd_done(chat_id, tid, args):
    if not args:
        return telegram.send_message(chat_id,
                                     "Tulis nomor/teks: /done beli susu")
    res = todos.done_todo(tid, args)
    telegram.send_message(chat_id,
                          f"✅ Selesai: {res['done']}" if res.get("success")
                          else f"❌ {res.get('error', 'Gagal')}")



def _cmd_hapus(chat_id, tid, args):
    if not args:
        return telegram.send_message(chat_id,
                                     "Tulis nomor/teks: /hapus beli susu")
    res = todos.remove_todo(tid, args)
    telegram.send_message(chat_id,
                          f"🗑 Dihapus: {res['removed']}" if res.get("success")
                          else f"❌ {res.get('error', 'Gagal')}")



def _cmd_status(chat_id, tid, args):
    lines = ["⚡ Status " + _BOT_NAME + "\n"]
    # Supabase
    try:
        base, _ = _config()
        with httpx.Client(timeout=8) as client:
            r = client.get(f"{base}/rest/v1/tasks",
                           params={"select": "id", "limit": "1"},
                           headers=_auth_headers())
            lines.append("Supabase: " + ("✅ up" if r.status_code < 400
                                         else "❌ down"))
    except Exception:
        lines.append("Supabase: ❌ down")
    # Pending tasks
    try:
        pending = supabase_client.count_tasks("PENDING")
        processing = supabase_client.count_tasks("PROCESSING")
        failed = supabase_client.count_tasks("FAILED")
        lines.append(f"Tasks: {pending} pending, {processing} processing, "
                     f"{failed} failed")
    except Exception:
        pass
    # Todo count
    items = todos._get_items(tid, "pending")
    lines.append(f"Todo: {len(items)} pending")
    lines.append(f"Waktu: {datetime.datetime.now(ZoneInfo('Asia/Jakarta')).strftime('%Y-%m-%d %H:%M WIB')}")
    telegram.send_message(chat_id, "\n".join(lines))


def _cmd_waktu(chat_id, tid, args):
    res = world_time(args)
    if res.get("success"):
        r = res
        telegram.send_message(chat_id,
            f"🕐 {r['local_time']} ({r['zone']})\n"
            f"📅 {r['weekday']}, offset {r['utc_offset']}\n"
            f"🌍 UTC: {r['utc_now']}")
    else:
        telegram.send_message(chat_id, f"❌ {res.get('error')}")


def _cmd_cuaca(chat_id, tid, args):
    if not args:
        return telegram.send_message(chat_id, "Tulis kota: /cuaca Jakarta")
    res = get_weather(args)
    if res.get("success"):
        r = res
        telegram.send_message(chat_id,
            f"🌤 {r['place']}\n"
            f"Kondisi: {r['description']}\n"
            f"Suhu: {r['temperature_celsius']}°C\n"
            f"Min/Max: {r['today_min_celsius']}°C / {r['today_max_celsius']}°C\n"
            f"Hujan: {r['rain_probability']}")
    else:
        telegram.send_message(chat_id, f"❌ {res.get('error')}")


def _cmd_ip(chat_id, tid, args):
    res = geo_info(args)
    if res.get("success"):
        r = res
        telegram.send_message(chat_id,
            f"🌐 {r['ip']}\n"
            f"📍 {r['city']}, {r['region']}, {r['country']}\n"
            f"🏢 {r['org']}\n"
            f"🕐 {r['timezone']}")
    else:
        telegram.send_message(chat_id, f"❌ {res.get('error')}")


def _cmd_kurs(chat_id, tid, args):
    parts = args.upper().split()
    if len(parts) < 2:
        return telegram.send_message(chat_id,
                                     "Format: /kurs USD IDR\n"
                                     "atau: /kurs 100 USD IDR")
    if len(parts) == 2:
        amount, src, dst = 1.0, parts[0], parts[1]
    else:
        amount, src, dst = float(parts[0]), parts[1], parts[2]
    from utils.misc_tools import convert_currency
    res = convert_currency(amount, src, dst)
    if res.get("success"):
        telegram.send_message(chat_id, f"💱 {res['result']}")
    else:
        telegram.send_message(chat_id, f"❌ {res.get('error')}")


def _cmd_kripto(chat_id, tid, args):
    if not args:
        return telegram.send_message(chat_id,
                                     "Format: /kripto BTC\n"
                                     "/kripto BTC idr")
    parts = args.split()
    coin = parts[0]
    cur = parts[1] if len(parts) > 1 else "usd"
    res = crypto_price(coin, cur)
    if res.get("success"):
        telegram.send_message(chat_id, f"🪙 {coin.upper()}: {res['result']}")
    else:
        telegram.send_message(chat_id, f"❌ {res.get('error')}")


def _cmd_ingat(chat_id, tid, args):
    if ":" not in args:
        return telegram.send_message(chat_id,
                                     "Format: /ingat Judul: Isi catatan")
    title, content = args.split(":", 1)
    res = store_document(title.strip(), content.strip())
    if res.get("success"):
        telegram.send_message(chat_id, f"📝 Catatan '{title.strip()}' tersimpan.")
    else:
        telegram.send_message(chat_id, f"❌ {res.get('error')}")


def _cmd_cari(chat_id, tid, args):
    if not args:
        return telegram.send_message(chat_id, "Format: /cari harga emas")
    telegram.send_typing(chat_id)
    res = _search_live(args)
    if res.get("answer"):
        telegram.send_message(chat_id, f"🔍 {res['answer'][:3500]}")
    else:
        telegram.send_message(chat_id, "❌ Tidak ada hasil.")


def _cmd_ringkas(chat_id, tid, args):
    if not args:
        return telegram.send_message(chat_id, "Format: /ringkas <url>")
    url = args if args.startswith("http") else "https://" + args
    telegram.send_typing(chat_id)
    from utils.search_tools import scrape_url
    content = scrape_url(url, max_chars=8000)
    if content.startswith("Error"):
        return telegram.send_message(chat_id, f"❌ {content}")
    if len(content.strip()) < 80:
        return telegram.send_message(chat_id, "❌ Halaman terlalu pendek/berbayar.")
    from utils.groq_client import sync_completion
    prompt = (
        "Ringkas halaman web berikut dalam bahasa Indonesia. Maksimal 6 poin, "
        "tanpa kalimat pembuka, tanpa menyebut teks HTML.\n\n"
        f"URL: {url}\n\nISI HALAMAN:\n{content}"
    )
    try:
        response = sync_completion(prompt, system_prompt=None)
        summary = (response.choices[0].message.content or "").strip()
    except Exception as exc:
        return telegram.send_message(chat_id, f"❌ Gagal merangkum: {exc}")
    telegram.send_message(chat_id, f"📄 {url}\n\n{summary[:3500]}")


def _cmd_jadwal(chat_id, tid, args):
    """/jadwal <menit> <prompt> — buat jadwal otonom."""
    parts = args.split(maxsplit=1)
    if len(parts) < 2 or not parts[0].isdigit():
        return telegram.send_message(
            chat_id,
            "Format: /jadwal <menit> <prompt>\n"
            "Contoh: /jadwal 1440 laporkan harga emas hari ini\n"
            "Jeda hingga 2x/hari, minimum 15 menit untuk test.",
        )
    interval = max(15, int(parts[0]))
    prompt = parts[1].strip()
    from utils.scheduler import create_job
    res = create_job(tid, interval, prompt)
    if res.get("error"):
        return telegram.send_message(chat_id,
                                     f"❌ {res['error']}\n\n"
                                     "Jalankan SQL autonomy_schema.sql di SQL "
                                     "Editor Supabase lalu /initautonomi.")
    job = res["job"]
    telegram.send_message(
        chat_id,
        f"⏰ Jadwal aktif!\nID: `{job.get('id')}`\n"
        f"Jeda: {job.get('interval_minutes')} menit\n"
        f"Prompt: {prompt}\n"
        f"Jalankan pertama: {job.get('next_run_at')[:16]}",
    )


def _cmd_list_jadwal(chat_id, tid, args):
    from utils.scheduler import list_jobs
    res = list_jobs(tid)
    if res.get("error"):
        return telegram.send_message(chat_id, f"❌ {res['error']}")
    jobs = res.get("jobs", [])
    if not jobs:
        return telegram.send_message(chat_id,
                                     "📭 Belum ada jadwal.\n"
                                     "Buat dengan: /jadwal <menit> <prompt>")
    lines = ["⏰ Jadwal aktif:\n"]
    for j in jobs:
        if j.get("cron_expr"):
            when = j["cron_expr"]
        else:
            when = f"{j.get('interval_minutes')} mnt"
        lines.append(f"• `{j['id']}` — {j['prompt'][:60]}\n"
                     f"  ⏱ {when} | next {j['next_run_at'][:16]} "
                     f"| {'✅' if j['enabled'] else '⬛'}\n"
                     f"  hapus: /hapusjadwal {j['id']}")
    telegram.send_message(chat_id, "\n".join(lines))


def _cmd_hapus_jadwal(chat_id, tid, args):
    if not args.isdigit():
        return telegram.send_message(chat_id, "Format: /hapusjadwal <id>")
    from utils.scheduler import delete_job
    res = delete_job(tid, int(args))
    telegram.send_message(chat_id, "🗑 Jadwal dihapus." if res.get("success")
                          else f"❌ {res.get('error', 'Gagal')}")


def _cmd_init_autonomi(chat_id, tid, args):
    """Check autonomy tables are live; seed default L3 jobs; instruct."""
    from utils.scheduler import list_jobs, seed_default_jobs
    res = list_jobs(tid)
    if res.get("error"):
        return telegram.send_message(
            chat_id,
            f"❌ Tabel autonomy belum siap.\n{res['error'][:200]}\n\n"
            "Buka Supabase → SQL Editor → tempel isi "
            "`sql/autonomy_schema.sql` → Run.\n"
            "Lalu jalankan /initautonomi lagi.",
        )
    seeded = seed_default_jobs(tid)
    msg = "✅ Mode otonom siap: preferences, jadwal, private integrations aktif."
    if seeded.get("created"):
        msg += f"\nJadwal default dibuat: {', '.join(seeded['created'])}."
    if seeded.get("skipped"):
        msg += f"\n(sudah ada: {', '.join(seeded['skipped'])})"
    if res.get("jobs"):
        msg += f"\n{len(res['jobs'])} jadwal aktif. Lihat dengan /listjadwal."
    telegram.send_message(chat_id, msg)


def _cmd_login(chat_id, tid, args):
    provider = args.strip().lower()
    if provider not in ("gmail", "google_drive", "notion", "calendar"):
        return telegram.send_message(
            chat_id,
            "Format: /login <provider>\n"
            "Provider: gmail, google_drive, notion, calendar (Google)\n\n"
            "Sebelum login, pastikan OAuth client (Google/Notion) sudah dibuat "
            "dan kredensialnya disimpan di Vault Supabase sebagai:\n"
            "oauth_google_client_id / oauth_google_client_secret\n"
            "atau oauth_notion_client_id / oauth_notion_client_secret.",
        )
    from utils import oauth2
    url = oauth2.authorize_url(provider, tid)
    if url.startswith("ERROR"):
        return telegram.send_message(
            chat_id, f"❌ {url}\n\nPastikan secret OAuth ada di Vault "
                     "(nonaktifkan wrappers untuk lihat instruksi).")
    telegram.send_message(
        chat_id,
        f"🔐 Buka link untuk menghubungkan **{provider}**:\n{url}\n"
        "Setelah izin, kamu kembali ke Telegram otomatis.",
    )


def _cmd_logout_provider(chat_id, tid, args):
    provider = args.strip().lower()
    if not provider:
        return telegram.send_message(chat_id,
                                     "Format: /logoutprov <provider>")
    from utils import authz
    ok = authz.disconnect_connection(tid, provider)
    telegram.send_message(chat_id, "🗑 Terputus."
                          if ok else f"❌ Tidak ada koneksi {provider}.")
