from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from app.auth.jwt_handler import authenticate_user, create_access_token, DEMO_USERS

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str
    user: dict


@router.post("/login", response_model=LoginResponse)
async def login(req: LoginRequest):
    user = authenticate_user(req.email, req.password)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    token = create_access_token({"sub": user["email"], "role": user["role"], "permissions": user["permissions"], "name": user["name"]})
    return {"access_token": token, "token_type": "bearer", "user": {"email": user["email"], "name": user["name"], "role": user["role"], "permissions": user["permissions"]}}


@router.get("/demo-users")
async def list_demo_users():
    return [{"email": e, "role": u["role"], "name": u["name"], "password": u["password"]} for e, u in DEMO_USERS.items()]
