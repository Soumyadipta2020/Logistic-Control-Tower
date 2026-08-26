from pydantic_settings import BaseSettings
from functools import lru_cache


import os

class Settings(BaseSettings):
    database_url: str = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./clt_local.db")
    redis_url: str = os.getenv("REDIS_URL", "")
    demo_mode: bool = True
    secret_key: str = "clt-super-secret-key-change-in-production-32chars"
    access_token_expire_minutes: int = 480
    environment: str = "development"
    log_level: str = "INFO"

    # ── Agentic AI layer ─────────────────────────────────────────────────────
    # Two ways in, and either alone is enough: Google AI Studio direct, or
    # OpenRouter for everything else (Claude, GPT, Grok, Llama…). Set both and
    # the operator picks per model in the panel — the key decides which models
    # are offered, so a missing key hides its models rather than failing a call.
    # Read from backend/.env (gitignored — see .env.example). No key at all →
    # the fleet falls back to deterministic grounded reasoning and the app works.
    google_api_key: str = os.getenv("GOOGLE_API_KEY", "")
    openrouter_api_key: str = os.getenv("OPENROUTER_API_KEY", "")
    llm_model: str = os.getenv("LLM_MODEL", "gemini-3.5-flash-lite")
    llm_enabled: bool = os.getenv("LLM_ENABLED", "true").lower() == "true"

    # OpenRouter attributes traffic to an app on its dashboards and leaderboards;
    # both headers are optional and cosmetic, and neither affects routing.
    openrouter_site_url: str = os.getenv("OPENROUTER_SITE_URL", "http://localhost:5173")
    openrouter_app_name: str = os.getenv("OPENROUTER_APP_NAME", "Centrica Logistics Control Tower")

    # Voice, when OpenRouter is the active provider. The TTS default is the same
    # Gemini model used against Google direct, so the tower sounds identical
    # whichever way the request is routed. STT has no Gemini equivalent on
    # OpenRouter, so a dedicated speech-to-text model stands in.
    openrouter_tts_model: str = os.getenv("OPENROUTER_TTS_MODEL", "google/gemini-3.1-flash-tts-preview")
    openrouter_stt_model: str = os.getenv("OPENROUTER_STT_MODEL", "openai/whisper-large-v3")

    class Config:
        env_file = ".env"
        extra = "ignore"

    @property
    def async_database_url(self) -> str:
        """Normalise Render's postgres:// to the asyncpg driver scheme or return sqlite."""
        url = self.database_url
        if url.startswith("postgres://"):
            return url.replace("postgres://", "postgresql+asyncpg://", 1)
        if url.startswith("postgresql://"):
            return url.replace("postgresql://", "postgresql+asyncpg://", 1)
        return url


@lru_cache
def get_settings() -> Settings:
    return Settings()
