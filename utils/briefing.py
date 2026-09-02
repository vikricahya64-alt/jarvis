"""
Proactive daily briefing composer (runs inside the daily cron).

Gathers a live-news headline, the user's city weather, and their pending
to-do list, then sends one consolidated Telegram message. Fully offline to
Groq (no LLM) so it fits the free budget and the 60s window.
"""
import datetime
from zoneinfo import ZoneInfo

from utils import telegram, todos
from utils.misc_tools import world_time, get_weather
from utils.search_tools import search_live


def _fetch(city: str = "Jakarta") -> str:
    """Build the briefing text for the cron's default user."""
    lines = []
    try:
        now = world_time("jakarta")
        if now.get("success"):
            lines.append(f"🌅 Selamat pagi! Sekarang {now['local_time']} WIB, "
                         f"{now['weekday']}.")
    except Exception:
        pass

    try:
        if city:
            w = get_weather(city)
            if w.get("success"):
                lines.append(
                    f"🌤 Cuaca {w['place']}: {w['description']}, "
                    f"{w['temperature_celsius']}°C "
                    f"(min {w['today_min_celsius']}°C, max "
                    f"{w['today_max_celsius']}°C, hujan {w['rain_probability']}).")
    except Exception:
        pass

    try:
        res = search_live("harga emas antam hari ini")
        if res.get("answer"):
            lines.append("📈 Berita ringkas: " + res["answer"][:400])
    except Exception:
        pass

    hydrated = todos.render_todo_list(_DEFAULT_TG)
    if hydrated and hydrated != "Belum ada item.":
        lines.append("\n✅ Todo Anda hari ini:\n" + hydrated)
    else:
        lines.append("\n✅ Tidak ada todo hari ini. Masih santai! 😄")

    if not lines:
        return "Selamat pagi 👋"
    return "\n".join(lines)


_DEFAULT_TG = 6812604983


def send_daily_briefing(telegram_id: int = _DEFAULT_TG, city: str = "Jakarta"):
    """Compose and send the daily briefing to a user."""
    text = _fetch(city)
    telegram.send_message(telegram_id, text)


if __name__ == "__main__":
    send_daily_briefing()
