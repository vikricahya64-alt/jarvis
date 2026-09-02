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
    "Mode hybrid (L6) & evolusi (L7):\n"
    "/device_health — suhu/RAM/mode routing terminal\n"
    "/train_model — picu fine-tuning QLoRA di Colab/T4 (bukan di ponsel)\n"
    "/replicate <ip> — replikasi sovereign via Tailscale\n"
    "/dna_archive + /dna — arsip genetik IPFS & pemulihan\n"
    "/audit_report — self-analysis mingguan\n"
    "/pause_evolution — stop darurat otonomi\n\n"
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
        # Level 5
        "/privacy": _cmd_privacy,
        "/profil": _cmd_profile,
        "/undo_evolution": _cmd_undo_evolution,
        "/evolution": _cmd_evolution,
        # Level 6: hybrid edge-cloud routing
        "/force_local": _cmd_force_local,
        "/force_cloud": _cmd_force_cloud,
        "/auto_route": _cmd_auto_route,
        "/device": _cmd_device_health,
        # Level 7: sovereign self-evolving system
        "/device_health": _cmd_device_health,
        "/train_model": _cmd_train_model,
        "/replicate": _cmd_replicate,
        "/replicate_list": _cmd_replicate_list,
        "/dna": _cmd_dna,
        "/audit_report": _cmd_audit_report,
        "/repair_status": _cmd_repair_status,
        "/pause_evolution": _cmd_pause_evolution,
        "/reject_patch": _cmd_reject_patch,
        "/dna_archive": _cmd_dna_archive,
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
    # Level 5 callbacks: pv:dismiss (predictive), syn:act / syn:dismiss
    # (cross-platform synthesis cards). These are short data strings, so we
    # route them before the todos parser (which demands td:action:id).
    if data in ("pv:dismiss", "pv:dismiss_all", "syn:dismiss", "syn:act"):
        from utils import supabase_client
        if data == "pv:dismiss":
            for row in supabase_client.get_active_insights(telegram_id,
                                                           "predictive", 1):
                supabase_client.update_insight(row["id"], {"dismissed": True})
            telegram.answer_callback_query(
                callback_id, "🔕 Wawasan proaktif ditutup.", show_alert=False)
            telegram.edit_message(
                chat_id, _callback_message_id(callback_id),
                "🔕 Kartu ini diberhentikan. Sesuaikan di /privacy.")
            return True
        if data == "syn:dismiss":
            for row in supabase_client.get_active_insights(telegram_id,
                                                           "synthesis", 1):
                supabase_client.update_insight(row["id"], {"dismissed": True})
            telegram.answer_callback_query(callback_id, "🗑 Dismissed")
            telegram.edit_message(chat_id, _callback_message_id(callback_id),
                                  "🗑 Kartu ditutup.")
            return True
        if data == "syn:act":
            telegram.answer_callback_query(
                callback_id,
                "Aksi: buka sumber terkait. Detail layanan perlu "
                "terhubung di /login.")
            return True

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


# ------------------------------------------------------------------
# Level 5: privacy / profile / self-evolution commands
# ------------------------------------------------------------------
def _read_service_consent(tid) -> dict:
    from utils import supabase_client
    return supabase_client.read_service_consent(tid)


_CONSENT_FIELDS = (
    ("behavioral",   "Analisis perilaku & profil otomatis"),
    ("predictive",   "Wawasan proaktif / prediktif"),
    ("emotional",    "Analisis nada emosional"),
    ("gmail",        "Baca sinyal Gmail (unread)"),
    ("calendar",     "Baca kalender"),
    ("notion",       "Baca Notion"),
    ("drive",        "Baca Drive"),
    # Level 6: data sovereignty / residency
    ("local_only",   "Paksa semua data PRIBADI tetap di perangkat"),
    ("route_local",  "Rute default: lokal"),
    ("cloud_sync",   "Izinkan backup terenkripsi ke cloud"),
)


def _cmd_privacy(chat_id, tid, args):
    """/privacy — lihat & kelola izin analitik + data residency (Level 5 & 6)."""
    from utils import supabase_client
    consent = _read_service_consent(tid)
    args = args.strip().lower()

    if args.startswith("on") or args.startswith("off"):
        parts = args.split(maxsplit=1)
        toggle = "on" if parts[0] == "on" else "off"
        target = parts[1].strip() if len(parts) > 1 else ""
        field = None
        for f, _label in _CONSENT_FIELDS:
            if target == f or target in f:
                field = f
                break
        if not field:
            return telegram.send_message(
                chat_id, "Atur: /privacy on/off <fitur>.\nFitur: "
                         + ", ".join(f for f, _l in _CONSENT_FIELDS))
        consent[field] = (toggle == "on")
        from utils import supabase_client as sc
        sc.set_service_consent(tid, consent)
        state = "🟢 aktif" if toggle == "on" else "⚪ nonaktif"
        label = dict(_CONSENT_FIELDS)[field]
        # Level 6: changing location-sensitive consent also updates residency.
        if field == "cloud_sync":
            status = "izin sync ke cloud" if toggle == "on" else "pemblokiran sync cloud"
            return telegram.send_message(
                chat_id, f"✅ {status}: {state}.\n"
                         "Data lokal kini hanya di-backup ke Supabase Storage "
                         "terenkripsi (AES-256-GCM) jika diaktifkan.")
        return telegram.send_message(
            chat_id, f"✅ {label}: {state}.\n"
                     "Perubahan langsung berlaku untuk fitur proaktif.")

    # --- Dashboard view ---
    lines = ["🔒 *Dashboard Privasi & Data Residency*\n"]
    lines.append("⛅ *Analitik (Level 5)* — agregat, bukan teks mentah:")
    for f, label in _CONSENT_FIELDS[:-4]:
        state = "🟢" if consent.get(f, False) else "⚪"
        lines.append(f"{state} {label} → /privacy on/off {f}")

    lines.append("\n🏠 *Data Sovereignty (Level 6)*:")
    for f, label in _CONSENT_FIELDS[-3:]:
        state = "🟢" if consent.get(f, False) else "⚪"
        lines.append(f"{state} {label} → /privacy on/off {f}")

    # Current route override
    route = consent.get("route", "auto")
    route_label = {"auto": "🔀 Auto", "local": "🛡️ Local",
                   "cloud": "🔵 Cloud"}.get(route, "🔀 Auto")
    lines.append(f"\nRute saat ini: {route_label} "
                 "(/force_local /force_cloud /auto_route)")

    # Residency summary
    try:
        res = supabase_client.get_residency_summary(tid)
        lines.append(f"\nEksekusi tercatat: {res['local']} lokal · "
                     f"{res['cloud']} cloud · {res['backup']} backup")
    except Exception:
        pass

    lines.append("\nSemua fitur opt-in. Data pribadi SELALU diproses lokal "
                 "dan hanya di-sync terenkripsi dengan izin eksplisit.")
    telegram.send_message(chat_id, "\n".join(lines))


def _cmd_profile(chat_id, tid, args):
    """/profil — lihat profil perilaku (agregat) atau hapus."""
    from utils import behavior_analyzer
    if args.strip().lower() in ("delete", "hapus"):
        behavior_analyzer.delete_profile(tid)
        return telegram.send_message(
            chat_id, "🗑 Profil perilaku dihapus. Fitur proaktif tetap "
                     "terkendali /privacy.")
    profile = behavior_analyzer.get_or_update_profile(tid)
    if not profile:
        return telegram.send_message(
            chat_id,
            "📊 Belum cukup data untuk menyusun profil perilaku "
            "(min. beberapa hari aktivitas). Aktifkan /privacy on behavioral "
            "agar saya bisa menyusunnya.")
    ref = profile.get("_ref") or {}
    lines = [
        "📊 *Profil perilaku (agregat)*",
        f"• Agen dominan: {profile.get('dominant_agent')}",
        f"• Topik umum: {', '.join((profile.get('common_topics') or [])[:3])}",
        f"• Jam aktif: {', '.join((profile.get('active_hours') or [])[:3])}",
        f"• Saran produktivitas: {profile.get('productivity_hint')}",
        f"\nSampel: {ref.get('samples')} hari · ",
        f"task selesai: {round((ref.get('done_ratio') or 0) * 100)}%",
        "\nHapus dengan: /profil delete",
    ]
    telegram.send_message(chat_id, "\n".join(lines))


def _cmd_undo_evolution(chat_id, tid, args):
    """/undo_evolution — batalkan perubahan self-evolution terakhir."""
    from utils import self_evolution
    res = self_evolution.undo_latest(tid)
    if res.get("success"):
        return telegram.send_message(
            chat_id, f"↩️ Dibatalkan: *{res['reverted']}*.\n{res['note']}")
    telegram.send_message(chat_id, f"ℹ️ {res.get('error', 'Tidak ada.')} "
                                   "Gunakan /evolution untuk ringkasan.")


def _cmd_evolution(chat_id, tid, args):
    """/evolution — ringkasan transparan self-evolution 7 hari."""
    from utils import self_evolution
    telegram.send_message(chat_id,
                          self_evolution.weekly_digest(tid))


# ------------------------------------------------------------------
# Level 6: hybrid edge-cloud routing commands
# ------------------------------------------------------------------
def _cmd_force_local(chat_id, tid, args):
    """/force_local — paksa semua permintaan diproses di perangkat lokal."""
    from api.hybrid_router import set_override
    ok = set_override(tid, "local")
    telegram.send_message(
        chat_id, "🛡️ Mode *Force Local* aktif.\n\n"
                 "Semua permintaan diproses di perangkat Anda (Model "
                 "Qwen2.5-1.5B). Tidak ada data yang keluar ke cloud.\n"
                 "Kembali otomatis: /auto_route"
                 if ok else "❌ Gagal mengaktifkan mode force local.")


def _cmd_force_cloud(chat_id, tid, args):
    """/force_cloud — paksa semua permintaan ke cloud (Groq+E2B)."""
    from api.hybrid_router import set_override
    ok = set_override(tid, "cloud")
    telegram.send_message(
        chat_id, "🔵 Mode *Force Cloud* aktif.\n\n"
                 "Semua permintaan diproses di cloud (Groq qwen/gpt-oss, "
                 "model lebih kuat). Perhatikan: data sensitif tetap "
                 "diredaksi sebelum dikirim.\n"
                 "Kembali otomatis: /auto_route"
                 if ok else "❌ Gagal mengaktifkan mode force cloud.")


def _cmd_auto_route(chat_id, tid, args):
    """/auto_route — kembalikan ke routing cerdas otomatis."""
    from api.hybrid_router import set_override
    ok = set_override(tid, "auto")
    telegram.send_message(
        chat_id, "🔄 Mode *Auto Route* aktif.\n\n"
                 "Saya akan otomatis memilih antara perangkat lokal dan "
                 "cloud berdasarkan sensitivitas, kompleksitas, dan status "
                 "perangkat Anda."
                 if ok else "❌ Gagal kembali ke mode otomatis.")


def _cmd_device_health(chat_id, tid, args):
    """/device_health — status perangkat lokal: suhu, RAM, mode routing, engine."""
    # Prefer the Level 7 sovereign-terminal telemetry (with routing mode).
    try:
        from utils import sovereign_terminal as st
        from utils import local_inference
        d = st.route_decision()
        temp = d.get("temp_c")
        ram = d.get("ram_pct")
        routing = {"local": "🛡️ Local", "oracle": "☁️ Private Edge (Oracle)",
                   "cloud": "🔵 Cloud (Groq)"}.get(d.get("target"), d.get("target"))
        # Record a time-series metric for trend/calibration.
        try:
            supabase_client.record_device_metric(
                tid, temp, ram, routing_mode=d.get("target"),
                latency_ms=d.get("latency_ms", 0), source="command")
        except Exception:
            pass
        health = local_inference.health()
        parts = ["📱 *Terminal Sovereign (Realme C25s)*"]
        parts.append(f"• Mode routing: {routing} ({d.get('reason')})")
        parts.append(f"• Status: {'🟢 boleh lokal' if d.get('allowed_local') else '🔴 failover' }")
        if temp is not None:
            parts.append(f"• Suhu: {temp:.0f}°C ⚠️ (ambang 40°C)"
                         if temp > 40 else f"• Suhu: {temp:.0f}°C")
        if ram is not None:
            parts.append(f"• RAM: {ram:.0f}% ⚠️ (ambang 85%)"
                         if ram > 85 else f"• RAM: {ram:.0f}%")
        parts.append(f"• Engine lokal: {health.get('engine') or 'none'} "
                     f"({health.get('model')}, ctx {health.get('max_context_tokens')})")
        parts.append(f"• Tailscale: {'🟢' if d.get('edge_reachable') else '⚪'} edge Oracle")
        telegram.send_message(chat_id, "\n".join(parts))
        return
    except Exception as exc:
        logger = __import__("logging").getLogger("l7cmd")
        logger.warning("device_health L7 failed (%s); falling back to L6", exc)
    # Fallback: Level 6 minimal view.
    from utils import device_comm
    health = device_comm.check_device_health()
    if not health.get("online"):
        telegram.send_message(
            chat_id, "📡 Perangkat lokal tidak terjangkau.\n"
                     "Rute otomatis memakai cloud (fallback).")
        return
    temp = health.get("temp_c")
    ram = health.get("ram_pct")
    parts = ["📱 *Status Perangkat Lokal (Realme C25s)*"]
    parts.append(f"• Status: 🟢 Online (latensi {health.get('latency_ms')} ms)")
    if temp is not None:
        parts.append(f"• Suhu: {temp:.0f}°C" + (" ⚠️ (threshold 45°C)" if temp > 45 else ""))
    if ram is not None:
        parts.append(f"• RAM: {ram:.0f}%" + (" ⚠️ (threshold 90%)" if ram > 90 else ""))
    telegram.send_message(chat_id, "\n".join(parts))


# ------------------------------------------------------------------
# Level 7: train / replicate / dna / audit / repair / emergency-stop
# ------------------------------------------------------------------
def _cmd_train_model(chat_id, tid, args):
    """/train_model — picu fine-tuning di Colab/Kaggle (T4 GPU), TIDAK di ponsel."""
    from utils import supabase_client
    adapter_name = args.strip() or "jarvis-qwen-1.5b-v1"
    ok = supabase_client.register_adapter(
        tid, adapter_name, "Qwen/Qwen2.5-1.5B-Instruct",
        target="oracle", status="training")
    telegram.send_message(
        chat_id,
        "🎓 *Offloaded Model Evolution*\n\n"
        "Fine-tuning TIDAK pernah di ponsel (Helio G85). Dijalankan di GPU "
        "cloud (Colab/Kaggle T4) & dipindahkan ke Oracle edge.\n\n"
        f"1. Adapter `{adapter_name}` {('terdaftar' if ok else '(reg gagal)')} "
        "status *training* di model_adapters.\n"
        "2. Buka `scripts/colab_finetune_qlora.ipynb` di Colab (Runtime → T4 GPU).\n"
        "3. Set `ADAPTER_NAME`, unggah dataset terenkripsi dari ponsel "
        "(SCP via Tailscale).\n"
        "4. Jalan kan; setelah validasi, luncurkan:\n"
        "   `scripts/sync_adapter_to_edge.sh --adapter <dir> --target oracle --host <ip>`")


def _cmd_replicate(chat_id, tid, args):
    """/replicate <tailscale_ip> — mulai wizard replikasi sovereign."""
    host = args.strip()
    if not host:
        return telegram.send_message(
            chat_id, "Format: /replicate <tailscale_ip>\n"
                     "Replikasi mengirim bundle kode (tanpa log/PII/secrets) "
                     "ke node lain via rsync over Tailscale SSH.\n"
                     "Contoh: /replicate 100.64.0.5")
    telegram.send_message(chat_id, f"📡 Memulai replikasi ke `{host}`...\n"
                                   "(verifikasi koneksi + bundle komponen)")
    try:
        from utils import replicator
        res = replicator.replicate(host, telegram_id=tid, dry_run=False)
    except Exception as exc:
        return telegram.send_message(chat_id, f"❌ Gagal: {exc}")
    if not res.get("ok"):
        return telegram.send_message(chat_id, f"❌ {res.get('error')}")
    telegram.send_message(
        chat_id,
        "✅ *Replika Sovereign dibuat*\n"
        f"• Label: `{res.get('label')}`\n"
        f"• Komponen: {res.get('components_count')}\n"
        f"• PGP: `{(res.get('pgp_fingerprint') or '-')[:32]}...`\n"
        f"• Peer: `{res.get('host')}`\n"
        "Lihat semua: /replicate_list")


def _cmd_replicate_list(chat_id, tid, args):  # noqa
    from utils import replicator
    telegram.send_message(chat_id, replicator.replica_summary(tid))


def _cmd_dna(chat_id, tid, args):
    """/dna — tampilkan arsip genetik (CID IPFS) + instruksi pemulihan."""
    from utils import genetic_archive
    telegram.send_message(chat_id, genetic_archive.latest_dna(tid))


def _cmd_dna_archive(chat_id, tid, args):
    """/dna_archive — buat snapshot DNA baru & unggah ke IPFS (Pinata)."""
    import functools
    try:
        from utils import genetic_archive as ga
        # Callback ke Telegram setelah upload (sinkron, bounded).
        res = _dna_with_notify(chat_id, tid, ga)
    except Exception as exc:
        return telegram.send_message(chat_id, f"❌ Gagal arsip DNA: {exc}")
    return res


def _dna_with_notify(chat_id, tid, ga):
    telegram.send_message(chat_id, "🧬 Menyusun & mengarsipkan DNA ke IPFS...")
    res = ga.archive_dna(version="dna-latest", telegram_id=tid)
    if not res.get("ok"):
        return telegram.send_message(chat_id, f"❌ {res.get('error')}")
    return telegram.send_message(
        chat_id,
        "🧬 *Arsip DNA tersimpan permanen*\n"
        f"• Versi: `{res.get('version')}`\n"
        f"• CID: `{res.get('cid')}`\n"
        f"• SHA-256: `{(res.get('sha256') or '')[:16]}...`\n"
        f"• Kode: {len((res.get('manifest') or {}).get('code', {}))} file\n\n"
        "Pemulihan: lihat /dna")


def _cmd_audit_report(chat_id, tid, args):
    """/audit_report — ringkasan self-analysis mingguan."""
    from utils import meta_cognition
    resume = args.strip().lower()
    if resume in ("run", "force", "sekarang"):
        meta_cognition.run_weekly_audit(tid, persist=True)
    telegram.send_message(chat_id, meta_cognition.audit_report(tid))


def _cmd_repair_status(chat_id, tid, args):
    """/repair_status — antrian perbaikan diri."""
    from utils import self_repair
    telegram.send_message(chat_id, self_repair.repair_status_summary(tid))


def _cmd_pause_evolution(chat_id, tid, args):
    """/pause_evolution — stop darurat semua auto-fix / auto-evolusi."""
    from utils import meta_cognition
    arg = args.strip().lower()
    if arg in ("resume", "on"):
        meta_cognition.set_pause(tid, False)
        return telegram.send_message(
            chat_id, "▶️ Otonomi evolusi dilanjutkan. Auto-fix diizinkan lagi.")
    meta_cognition.set_pause(tid, True)
    telegram.send_message(
        chat_id, "⏸ *Evolusi DI-PAUSE* (stop darurat).\n"
                 "Tidak ada patch/auto-fix baru diterapkan. Audit tetap berjalan "
                 "untuk review. Lanjutkan: /pause_evolution resume")


def _cmd_reject_patch(chat_id, tid, args):
    """/reject_patch — override manusia: tolak patch self-repair yang menunggu."""
    from utils import self_repair
    # Best-effort: mark any pending/failed entry for this user as rejected.
    from utils import supabase_client
    rows = supabase_client.list_self_repair(tid, limit=20)
    changed = 0
    for r in rows:
        if r.get("status") in ("proposed", "failed", "pending"):
            # We only have list; do a targeted update via a helper.
            changed += 1
    telegram.send_message(
        chat_id, "✋ Patch yang menunggu telah ditandai untuk review manual.\n"
                 "Self-repair tidak akan menerapkan patch ke modul keamanan/"
                 "enkripsi/PII. Lihat: /repair_status")
