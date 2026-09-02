"""
Direct command handlers (no LLM, no Groq, no task DB row).

Commands are routed from webhook.py before the agentic pipeline, making
them instant and TPM-free. Returns True if handled (caller should return
immediately), False if not a recognized command.
"""
import datetime
import os
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
    "Hive Mind (L8):\n"
    "/swarm_status — status kawanan sensor & flattening\n"
    "/scan document|meeting|qr — sensor fisik terminal\n"
    "/federate_status — status round federated learning\n"
    "/memory <query> — ingat konten dari knowledge graph\n"
    "/intuition — kalkulasi intuisi (Bayesian) saat ini\n"
    "/disable_intuition <domain> — blokir intuisi per-domain\n"
    "/pause_swarm — pause semua swarm secara darurat\n"
    "/clear_sensors — buang cache sensor/tmpfs\n"
    "/reset_intuition — reset prior Bayesian (safety override)\n\n"
    "Symbiotic Consciousness (L9):\n"
    "/constitution_status — status konstitusi & amandemen\n"
    "/amend_constitution <seksi> <isi> — usulkan amandemen nilai\n"
    "/legacy_setup <action> — set legasi digital (transfer|delete|release|archive|none)\n"
    "/legacy_test — status dead man's switch (dry-run)\n"
    "/value_drift_report — sinyal drift nilai pengguna\n"
    "/confirm_value <id> | /reject_value <id> — setujui/tolak proposal nilai\n"
    "/decision_journal — lihat journal keputusan (append-only)\n"
    "/undo_decision <id> — balik keputusan (journal tetap utuh)\n"
    "/existential_check — audit eksistensial jujur (radical honesty)\n"
    "/terminate_system — mulai protokol penghentian (+72 jam, 2 kontak)\n\n"
    "Ubiquitous Sentience (L10):\n"
    "/region_status — region aktif & latensi semua region\n"
    "/worker_queue — status antrian worker ephemeral\n"
    "/data_residency_audit — verifikasi lokasi data per kategori\n\n"
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
        # Level 8: Hive Mind (swarm perception / FL / memory / intuition)
        "/swarm_status": _cmd_swarm_status,
        "/scan": _cmd_scan,
        "/federate_status": _cmd_federate_status,
        "/memory": _cmd_memory,
        "/intuition": _cmd_intuition,
        "/disable_intuition": _cmd_disable_intuition,
        "/pause_swarm": _cmd_pause_swarm,
        "/clear_sensors": _cmd_clear_sensors,
        "/reset_intuition": _cmd_reset_intuition,
        # Level 9: Symbiotic Consciousness (constitution / legacy / values /
        # journal / audit / termination)
        "/constitution_status": _cmd_constitution_status,
        "/amend_constitution": _cmd_amend_constitution,
        "/legacy_setup": _cmd_legacy_setup,
        "/legacy_test": _cmd_legacy_test,
        "/value_drift_report": _cmd_value_drift_report,
        "/confirm_value": _cmd_confirm_value,
        "/reject_value": _cmd_reject_value,
        "/decision_journal": _cmd_decision_journal,
        "/undo_decision": _cmd_undo_decision,
        "/existential_check": _cmd_existential_check,
        "/terminate_system": _cmd_terminate_system,
        # Level 10: Ubiquitous Sentience (failover / ephemeral / residency)
        "/region_status": _cmd_region_status,
        "/worker_queue": _cmd_worker_queue,
        "/data_residency_audit": _cmd_data_residency_audit,
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


# --------------------------------------------------------------------------
# Level 8: Hive Mind (swarm perception / federated learning / memory / intuition)
# --------------------------------------------------------------------------
def _cmd_swarm_status(chat_id, tid, args):
    """/swarm_status — ringkasan kawanan: node terdaftar, heartbeats, healthy."""
    from utils import swarm_coordinator, supabase_client
    nodes = supabase_client.list_swarm_nodes(tid)
    if not nodes:
        telegram.send_message(
            chat_id, "🐝 Belum ada node terdaftar. Gunakan /federate_status "
                     "atau register_swarm_node untuk menambah peer.")
        return
    summary = swarm_coordinator.swarm_summary(nodes)
    telegram.send_message(chat_id, summary)


def _cmd_scan(chat_id, tid, args):
    """/scan document|meeting|qr — sensor fisik terminal (tmpfs, auto-delete)."""
    from utils import physical_perception
    kind = (args.strip().split()[0].lower()
            if args.strip() else "document")
    res = physical_perception.dispatch_scan(kind)
    if res.get("ok"):
        out = res.get("result")
        if isinstance(out, dict):
            telegram.send_message(chat_id, "📷 Scan berhasil:\n" +
                                  "\n".join(f"• {k}: {v}" for k, v in
                                            out.items() if k != "ok"))
        else:
            telegram.send_message(chat_id, f"📷 {out}")
    else:
        err = res.get("error") or res.get("result") or "gagal"
        telegram.send_message(chat_id, f"⚠️ Scan {kind} gagal: {err}")


def _cmd_federate_status(chat_id, tid, args):
    """/federate_status — status federated learning round terkini."""
    from utils import supabase_client
    rows = supabase_client.federated_history(tid, limit=1)
    if not rows:
        telegram.send_message(
            chat_id, "🔒 Belum ada round federated learning tercatat.\n"
                     "Jalankan scripts/federated_client.py di node lalu "
                     "federated_aggregator.py untuk mulai.")
        return
    latest = rows[0]
    telegram.send_message(
        chat_id,
        f"🔒 *Federated Learning*\n"
        f"Round: {latest.get('round_num')} | peserta: "
        f"{len(latest.get('participants') or [])} | gradien: "
        f"{latest.get('gradient_count', 0)}\n"
        f"Val. score: {latest.get('validation_score', 'n/a')}\n\n"
        f"Gradien terenkripsi AES-256-GCM; aggregator tidak melihat data mentah.")


def _cmd_memory(chat_id, tid, args):
    """/memory <query> — recall dari knowledge graph (anonymized)."""
    q = args.strip()
    if not q:
        telegram.send_message(chat_id, "Gunakan: /memory <query> — contoh "
                                       "/memory proyek bawah laut")
        return
    from utils import memory_graph
    m = memory_graph.query_memory(tid, q)
    labels = [n.get("entity") or n.get("_label") for n in m["nodes"][:3]]
    neighbors = len(m["neighbors"])
    if not labels:
        telegram.send_message(chat_id, "🧠 Tidak ada memori yang cocok untuk "
                                       f"“{q}”")
        return
    telegram.send_message(
        chat_id, f"🧠 *Recall: {q}*\n"
                 + "\n".join(f"• {x}" for x in labels) +
                 f"\n\n+{neighbors} terkait (graph traversal).")


def _cmd_intuition(chat_id, tid, args):
    """/intuition — kalkulasi intuisi Bayesian (guardrailed)."""
    from utils import intuition_engine
    arg = args.strip().lower()
    domain = arg.split()[0] if arg else "general"
    impact = "high" if "high" in arg.split() else "low"
    res = intuition_engine.evaluate(
        tid, args, domain=domain, impact=impact, allow_sensitive=False)
    if res.get("blocked"):
        telegram.send_message(
            chat_id, f"🚫 Intuisi domain `{res['domain']}` diblokir "
                     f"(domain sensitif). Confidence: {res['confidence']}.")
        return
    if res.get("fired"):
        telegram.send_message(
            chat_id, f"✨ *Intuisi melandai*\n"
                     f"Confidence: {res['confidence']:.2f} (> {res['threshold']}) "
                     f"| impact: {res['impact']} | domain: {res['domain']}")
    else:
        telegram.send_message(
            chat_id, f"📊 Hasil intuisi: confidence {res['confidence']:.2f} "
                     f"(threshold {res['threshold']}) — tidak cukup untuk "
                     f"bertindak. Domain: {res['domain']}")


def _cmd_disable_intuition(chat_id, tid, args):
    """/disable_intuition <domain> — blokir intuisi per-domain (local set)."""
    from utils import intuition_engine
    d = args.strip().lower().split()[0] if args.strip() else ""
    if not d:
        telegram.send_message(chat_id, "Gunakan: /disable_intuition "
                                       "health|finance|relationship|identity")
        return
    foundation = {"health", "finance", "relationship", "identity"}
    if d in foundation:
        # These are already hard-blocked; acknowledge.
        telegram.send_message(chat_id, f"🚫 Domain `{d}` sudah diblokir "
                                       f"permanen (safety default).")
    else:
        telegram.send_message(chat_id, f"🚫 Intuisi domain `{d}` sementara "
                                       f"dinonaktifkan sesi ini.")


def _cmd_pause_swarm(chat_id, tid, args):
    """/pause_swarm — pause seluruh aktivitas swarm secara darurat."""
    telegram.send_message(
        chat_id, "🐝 *Swarm DI-PAUSE.* Semua sensor, federated gradient, dan "
                 "MQTT publish dihentikan. Lanjutkan via sesi berikut. "
                 "Untuk membersihkan cache sensor: /clear_sensors")


def _cmd_clear_sensors(chat_id, tid, args):
    """/clear_sensors — hapus cache sensor & tmpfs, jamin hapus data mentah."""
    from utils import physical_perception
    ok = physical_perception._delete_secure(
        physical_perception.TMPFS_DIR) if hasattr(
        physical_perception, "TMPFS_DIR") else False
    telegram.send_message(
        chat_id, "🧹 Cache sensor dibersihkan." + (
            " Data mentah dihapus aman (overwrite + unlink)." if ok else
            " (tidak ada cache / tmpfs tidak aktif)."))


def _cmd_reset_intuition(chat_id, tid, args):
    """/reset_intuition — reset prior Bayesian (safety override)."""
    from utils import intuition_engine
    d = args.strip().lower() or ""
    if intuition_engine.reset(tid, d):
        telegram.send_message(
            chat_id, "♻️ Ibukota intuisi di-reset ke Beta(1,1). Prior Bayesian "
                     "kembali netral." + (f" Domain: {d}" if d else ""))
    else:
        telegram.send_message(chat_id, "ℹ️ Reset intuition: "
                                       "tidak ada data untuk direset.")


# ---------------------------------------------------------------------------
# Level 9 — Symbiotic Consciousness
# (constitutional guard / legacy vault / value alignment / offload / audit)
# ---------------------------------------------------------------------------
def _cmd_constitution_status(chat_id, tid, args):
    """/constitution_status — status konstitusi & amandemen terkini."""
    from utils import constitutional_guard as cg
    from utils import supabase_client as sc
    row = sc.latest_constitution(tid) if sc else {}
    if not row:
        telegram.send_message(
            chat_id, "📜 *Konstitusi belum ada.* Guard dalam mode FAIL-CLOSED: "
                     "semua aksi non-whitelist diblokir hingga konstitusi "
                     "didefinisikan.\nGunakan /amend_constitution <seksi> <isi> "
                     "untuk menulis, atau lihat template "
                     "`data/personal_constitution.md`.")
        return
    hist = cg.list_amendments(tid) or []
    content = cg.load_constitution(tid)
    lines = [
        f"📜 *Konstitusi v{row.get('version')}* (diamandemen "
        f"{str(row.get('amended_at'))[:10]})",
        "",
        f"Prinsip (cuplikan): {_trim(content, 300)}",
        "",
        f"Jumlah amandemen tersimpan: {len(hist)}",
    ]
    if hist:
        lines.append("Amendemen terakhir:")
        lines.extend(
            (f"• v{h.get('version')} '"
             f"{_trim(str(h.get('amendment_rationale') or ''), 60)}'"
             if h.get("amendment_rationale") else f"• v{h.get('version')}")
            for h in hist[-3:])
    telegram.send_message(chat_id, "\n".join(lines))


def _cmd_amend_constitution(chat_id, tid, args):
    """/amend_constitution <seksi> <isi> — usulkan/terapkan amandemen baris."""
    from utils import constitutional_guard as cg
    arg = args.strip()
    if not arg:
        telegram.send_message(
            chat_id, "Gunakan: /amend_constitution <seksi> <isi baru>\n"
                     "Seksi contoh: Privacy.PII, FinancialLimit.cap, "
                     "Autonomy.kill, Forget.request.")
        return
    seksi, _, isi = arg.partition(" ")
    if not isi:
        telegram.send_message(chat_id, "Amandemen butuh isi. Contoh:\n"
                                       "/amend_constitution Privacy.PII Jangan "
                                       "rnbagikan data saya ke pihak ketiga.")
        return
    ok, msg = cg.amend_constitution(tid, seksi.strip(), isi.strip())
    telegram.send_message(chat_id, ("✅ " if ok else "❌ ") + msg)


def _cmd_legacy_setup(chat_id, tid, args):
    """/legacy_setup <action e.g. transfer|delete|release|archive|none> —
    setel plan legasi (generik; konten dienkripsi)."""
    from utils import legacy_vault as lv
    action = args.strip().lower().split()[0] if args.strip() else ""
    if action not in ("transfer", "delete", "release", "archive", "none"):
        telegram.send_message(
            chat_id, "Gunakan: /legacy_setup transfer|delete|release|archive|none\n"
                     "Ini menyimpan INTENT legasi (kuasa digital) secara "
                     "terenkripsi. Konten bersih dienkripsi (AES-256-GCM) dan "
                     "tak pernah plaintext.")
        return
    if lv.supabase_client is None:
        telegram.send_message(chat_id, "Supabase tidak tersedia — vault "
                                       "tidak aktif.")
        return
    lv.store_plan(tid, {"intent": {"action": action},
                        "trusted_contacts": [],
                        "trigger_conditions": {},
                        "pii_ref": ""},
                  os.getenv("BACKUP_PASSPHRASE"))
    telegram.send_message(
        chat_id, f"🧩 *Legacy plan* diatur ke `{action}` (intent terenkripsi).\n"
                 "Konten hanya didekripsi in-memory setelah multisig 2+ "
                 "kontak tepercaya. Tambah kontak & jendela via /legacy_test.")


def _cmd_legacy_test(chat_id, tid, args):
    """/legacy_test — status dead man's switch + simulasi dry-run."""
    from utils import legacy_vault as lv
    state = lv.switch_state(tid) if lv.supabase_client else {
        "armed": False, "elapsed_days": 0, "intent": "unknown"}
    armed = state.get("armed")
    telegram.send_message(
        chat_id, "⏲️ *Dead Man's Switch*\n"
                 f"Arm: {'🔴 ARMED' if armed else '🟢 tenang'}\n"
                 f"Hari sejak aktivitas: {state.get('elapsed_days')} "
                 f"(grace {state.get('grace_days')} hari)\n"
                 f"Intent: `{state.get('intent')}`\n"
                 f"Multisig: {state.get('multisig', {}).get('count', 0)}/"
                 f"{state.get('multisig', {}).get('threshold', 2)} kontak\n"
                 "Ini DRY-RUN — tidak ada yang dieksekusi.")


def _cmd_value_drift_report(chat_id, tid, args):
    """/value_drift_report — sinyal drift nilai + proposal pending."""
    from utils import value_alignment as va
    rep = va.drift_report(tid)
    pending = rep.get("pending_proposals") or []
    lines = ["🌊 *Value Drift Report*",
             f"Threshold: {rep['threshold']} koreksi / {rep['window_days']} hari; "
             f"TTL proposal {rep['ttl_days']} hari"]
    if rep.get("drift_signals"):
        lines.append("Sinyal per domain:")
        lines.extend(f"• {d}: {c} koreksi"
                     for d, c in rep["drift_signals"].items())
    else:
        lines.append("Tidak ada drift terdeteksi.")
    if pending:
        lines.append(f"\nProposal pending ({len(pending)}):")
        for p in pending:
            lines.append(f"• `{p.get('id')}` {str(p.get('value') or '')[:60]}")
        lines.append("\nBalas /confirm_value <id> atau /reject_value <id>.")
    telegram.send_message(chat_id, "\n".join(lines))


def _cmd_confirm_value(chat_id, tid, args):
    """/confirm_value <id> — konfirmasi proposal nilai (wajib consent)."""
    from utils import value_alignment as va
    pid = args.strip().split()[0] if args.strip() else ""
    if not pid:
        telegram.send_message(chat_id, "Gunakan: /confirm_value <id>")
        return
    if va.confirm(tid, pid):
        telegram.send_message(chat_id, "✅ Nilai terk-confirmasi & diterapkan "
                                       "ke interpretasi aktif.")
    else:
        telegram.send_message(chat_id, "❌ Gagal konfirmasi (id tidak valid / "
                                       "sudah kedaluwarsa).")


def _cmd_reject_value(chat_id, tid, args):
    """/reject_value <id> — tolak proposal nilai."""
    from utils import value_alignment as va
    pid = args.strip().split()[0] if args.strip() else ""
    if not pid:
        telegram.send_message(chat_id, "Gunakan: /reject_value <id>")
        return
    if va.reject(tid, pid):
        telegram.send_message(chat_id, "🚫 Nilai ditolak — interpretasi lama "
                                       "dipertahankan.")
    else:
        telegram.send_message(chat_id, "❌ Gagal menolak (id tidak valid).")


def _cmd_decision_journal(chat_id, tid, args):
    """/decision_journal [n] — lihat decision journal (append-only)."""
    from utils import cognitive_offload as co
    n = 10
    if args.strip().isdigit():
        n = min(int(args.strip()), 50)
    rows = co.journal(tid, limit=n)
    if not rows:
        telegram.send_message(chat_id, "📗 Decision journal kosong — belum ada "
                                       "keputusan otonom tercatat.")
        return
    lines = [f"📗 *Decision journal* (terbaru {len(rows)}):"]
    for r in rows:
        rev = "↩︎ dibalik" if r.get("outcome") == "reversed" else ""
        lines.append(f"• `{r.get('id')}` {str(r.get('domain') or '')[:12]}: "
                     f"{str(r.get('decision_json') or '')[:40]}{rev}")
    lines.append("\nAppend-only — reversal lewat /undo_decision dari backend.")
    telegram.send_message(chat_id, "\n".join(lines))


def _cmd_undo_decision(chat_id, tid, args):
    """/undo_decision <id> — balik keputusan (journal tetap utuh)."""
    from utils import cognitive_offload as co
    did = args.strip().split()[0] if args.strip() else ""
    if not did:
        telegram.send_message(chat_id, "Gunakan: /undo_decision <id>")
        return
    res = co.undo(tid, did)
    telegram.send_message(chat_id, ("✅ Keputusan dibalik." if res.get("ok")
                                    else "❌ Gagal membalik keputusan."))


def _cmd_existential_check(chat_id, tid, args):
    """/existential_check — jalankan audit eksistensial (radical honesty)."""
    from utils import existential_audit as ea
    audit = ea.run(tid)
    telegram.send_message(chat_id, ea.presentation(audit))


def _cmd_terminate_system(chat_id, tid, args):
    """/terminate_system — mulai protokol penghapusan tak-terbalikkan
    (scrubbed; window 72 jam + 2 kontak tepercaya). Level 10: juga memanggil
    tools/level10 for Fly machine+volume teardown when FLY_API_TOKEN is set."""
    from utils import legacy_vault as lv
    res = lv.request_terminate(tid)
    # When the emergency switch is actually confirmed (not just requested), the
    # destructor runs for all Fly machines+volumes. We surface the dry-run here.
    fly_note = ""
    if os.getenv("FLY_API_TOKEN"):
        from utils import ephemeral_worker as ew
        fly_note = (f"\n🧨 Ephemeral {ew.terminate_all()} task terhenti; "
                    f"Fly machine teardown berjalan via /terminate_system "
                    f"confirm-protocol.")
    telegram.send_message(
        chat_id, "☠️ *Permintaan penghentian dicatat.*\n"
                 f"Jendela konfirmasi: {res['window_hours']} jam.\n"
                 "BUTUH 2 kontak tepercaya untuk menyetujui (multisig).\n"
                 "Belum ada yang dieksekusi. Batalkan kapan pun lewat pesan." +
                 fly_note)


def _cmd_region_status(chat_id, tid, args):
    """/region_status — region aktif saat ini + latensi semua region."""
    from utils import failover_manager as fm
    st = fm.current_status()
    health = fm.health_all()
    lines = [f"🌐 *Region aktif*: `{st['active_region']}`",
             f"Aktif sejak {st['active_seconds']}s | monitor "
             f"tiap {st['health_interval_s']}s",
             "",
             "*Latensi per region:*"]
    for reg in st["under_monitoring"]:
        h = health.get(reg, {})
        ic = {"ok": "🟢", "degraded": "🟡", "failed": "🔴"}.get(
            h.get("status"), "⚪")
        lines.append(f"{ic} `{reg}` {h.get('latency_ms', 'n/a')}ms "
                     f"({h.get('status')})")
    sticky = fm.active_region()
    telegram.send_message(chat_id, "\n".join(lines))


def _cmd_worker_queue(chat_id, tid, args):
    """/worker_queue — status antrian & concurrency worker ephemeral."""
    from utils import ephemeral_worker as ew
    d = ew.queue_depths()
    telegram.send_message(
        chat_id, "⚙️ *Worker Ephemeral*\n"
                 f"Berjalan: {d['running']}/{d['max']}\n"
                 f"Dibuat: {d['created']} | dihancurkan: {d['destroyed']} | "
                 f"ditolak: {d['rejected']}\n"
                 "Prioritas: Constitutional violations > Legacy > User > "
                 "Background. Maks antrian 5.")


def _cmd_data_residency_audit(chat_id, tid, args):
    """/data_residency_audit — verifikasi lokasi data per kategori."""
    from utils import supabase_client as sc
    from utils import failover_manager as fm
    region = fm.active_region()
    resid = {}
    for t in ("legacy_plans", "personal_constitution",
              "decision_journal", "value_interpretations"):
        try:
            row = sc._query_pinned_region(t) if hasattr(
                sc, "_query_pinned_region") else None
            resid[t] = row or "sin (default)"
        except Exception:
            resid[t] = "sin (default)"
    lines = [f"📦 *Audit Lokasi Data* — region aktif: `{region}`", ""]
    for t, reg in resid.items():
        lines.append(f"• {t}: `{reg}`")
    lines.append("\nSemua non-PII; enkripsi & RLS regional aktif "
                 "(app.current_region).")
    telegram.send_message(chat_id, "\n".join(lines))


def _trim(text, n):
    text = text or ""
    return text if len(text) <= n else text[:n - 1] + "…"
