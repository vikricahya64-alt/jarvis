"""
E2B Code Interpreter executor: the "Hands" of J.A.R.V.I.S.

Securely runs Python/JS in an isolated cloud sandbox, captures stdout,
and downloads any generated files (PNG/CSV/JSON/PDF).
"""
import os
import base64

try:
    from e2b_code_interpreter import Sandbox
    E2B_AVAILABLE = True
except ImportError:
    E2B_AVAILABLE = False


def execute_code(code: str, language: str = "python") -> dict:
    """
    Execute code in an E2B sandbox and return stdout + generated files.

    Args:
        code: The source code to run.
        language: 'python' or 'javascript'.

    Returns:
        A dict: {success, stdout, stderr, files: [{name, data_b64, mime}]}
    """
    if not E2B_AVAILABLE:
        return {
            "success": False,
            "stdout": "",
            "stderr": "e2b-code-interpreter library not installed",
            "files": [],
        }

    api_key = os.getenv("E2B_API_KEY")
    if not api_key:
        return {
            "success": False,
            "stdout": "",
            "stderr": "E2B_API_KEY is not configured",
            "files": [],
        }

    return _run_sandbox(code, language)


def _run_sandbox(code: str, language: str) -> dict:
    sbx = None
    try:
        sbx = Sandbox()
        if language == "javascript":
            sbx.commands.run("npm install -g node 2>/dev/null || true")
            result = sbx.run_code(code, language="javascript")
        else:
            # Ensure common libs are available (cached between runs)
            sbx.commands.run(
                "pip install --quiet pandas matplotlib numpy 2>/dev/null || true"
            )
            result = sbx.run_code(code, language="python")

        stdout = result.text if result.text else ""
        stderr = getattr(result, "stderr", "") or ""

        # Download generated files referenced by relative paths
        files = _collect_files(sbx, ["png", "csv", "json", "pdf", "xlsx", "html"])

        return {
            "success": True,
            "stdout": stdout,
            "stderr": stderr,
            "files": files,
        }
    except Exception as exc:
        return {
            "success": False,
            "stdout": "",
            "stderr": f"E2B sandbox error: {exc}",
            "files": [],
        }
    finally:
        if sbx is not None:
            try:
                sbx.kill()
            except Exception:
                pass


def _collect_files(sbx, extensions):
    """
    Scan common working directories in the sandbox for generated files.
    E2B's run_code result exposes `files`; we also probe openai files.
    """
    files = []
    try:
        # Best effort: list files in /home/user and current dir
        for ext in extensions:
            listing = sbx.files.list(f"/home/user/*.{ext}")
            for handle in listing:
                data = sbx.files.read_bytes(f"/home/user/{handle.name}")
                files.append({
                    "name": handle.name,
                    "data_b64": base64.b64encode(data).decode(),
                    "mime": _mime_for(ext),
                })
    except Exception:
        pass
    return files


def _mime_for(ext: str) -> str:
    mapping = {
        "png": "image/png",
        "csv": "text/csv",
        "json": "application/json",
        "pdf": "application/pdf",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "html": "text/html",
        "txt": "text/plain",
    }
    return mapping.get(ext, "application/octet-stream")
