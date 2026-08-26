import os
import sys
import subprocess
import threading

def stream_output(pipe, prefix):
    for line in iter(pipe.readline, b''):
        # Decode and handle potentially problematic characters
        try:
            decoded_line = line.decode('utf-8', errors='replace')
            sys.stdout.write(f"[{prefix}] {decoded_line}")
            sys.stdout.flush()
        except Exception:
            pass

def main():
    root_dir = os.path.dirname(os.path.abspath(__file__))
    backend_dir = os.path.join(root_dir, "backend")
    frontend_dir = os.path.join(root_dir, "frontend")

    print("Starting backend and frontend concurrently...")

    # Ensure SQLite default when running locally if Postgres is not configured
    backend_env = os.environ.copy()
    if "DATABASE_URL" not in backend_env or "postgresql" in backend_env.get("DATABASE_URL", ""):
        backend_env["DATABASE_URL"] = "sqlite+aiosqlite:///./clt_local.db"

    # Start backend
    backend_process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"],
        cwd=backend_dir,
        env=backend_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT
    )

    # Start frontend
    import shutil
    if os.name == "nt":
        npm_cmd = "npm.cmd" if shutil.which("npm.cmd") else "npm"
        if not shutil.which("node") and os.path.exists(r"C:\Program Files\nodejs\node.exe"):
            os.environ["PATH"] += os.pathsep + r"C:\Program Files\nodejs"
    else:
        npm_cmd = "npm"
            
    frontend_process = subprocess.Popen(
        f"{npm_cmd} run dev",
        cwd=frontend_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=True
    )

    # Thread to stream output
    threading.Thread(target=stream_output, args=(backend_process.stdout, "BACKEND"), daemon=True).start()
    threading.Thread(target=stream_output, args=(frontend_process.stdout, "FRONTEND"), daemon=True).start()

    import time
    import webbrowser
    
    # Wait a moment to let servers start
    time.sleep(3)
    
    frontend_url = "http://localhost:5173/"
    print("\n" + "="*50)
    print("Application is running!")
    print(f"Frontend URL: {frontend_url}")
    print("Backend API: http://127.0.0.1:8000/")
    print("="*50 + "\n")
    
    try:
        webbrowser.open(frontend_url)
    except Exception as e:
        print(f"Could not open browser automatically: {e}")

    try:
        # Keep the main thread alive while subprocesses are running
        backend_process.wait()
        frontend_process.wait()
    except KeyboardInterrupt:
        print("\nShutting down processes...")
        if os.name == "nt":
            subprocess.run(f"taskkill /F /T /PID {backend_process.pid}", shell=True, capture_output=True)
            subprocess.run(f"taskkill /F /T /PID {frontend_process.pid}", shell=True, capture_output=True)
        else:
            backend_process.terminate()
            frontend_process.terminate()
            backend_process.wait()
            frontend_process.wait()
        print("Shutdown complete.")

if __name__ == "__main__":
    main()
