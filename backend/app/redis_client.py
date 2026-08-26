try:
    import redis.asyncio as aioredis
except ImportError:
    aioredis = None
from app.config import get_settings

settings = get_settings()
_redis = None

class MockRedis:
    async def close(self):
        pass

async def get_redis():
    global _redis
    if _redis is None:
        if settings.redis_url and aioredis is not None:
            _redis = aioredis.from_url(settings.redis_url, decode_responses=True, max_connections=20)
        else:
            _redis = MockRedis()
    return _redis

async def close_redis():
    pass
