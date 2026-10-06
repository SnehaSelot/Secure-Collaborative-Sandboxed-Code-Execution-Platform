"""Per-language regex rule tables for the Phase 0 rules-only scorer.

Each rule: (id, category, weight, regex, description).
  * weight is the rule's own "probability of malicious", 0..0.95.
  * Scores combine with noisy-OR:  p = 1 - prod(1 - w_i)  -> score = round(100 * p).
  * Each rule fires at most once per scan (first match is reported, hits are counted).
  * COMBOS add an extra finding when several rules co-occur (e.g. socket + dup2 + exec).

Languages: python, javascript, java, c, cpp, go, rust.  COMMON_RULES apply to every
language (shell one-liners, secret paths, exfil endpoints, blobs), including unknown ones.
Regexes avoid nested quantifiers so scanning stays linear on large inputs.
"""
from __future__ import annotations

import re
from functools import lru_cache
from typing import NamedTuple


class Rule(NamedTuple):
    id: str
    category: str
    weight: float
    pattern: str
    description: str


class Combo(NamedTuple):
    id: str
    requires: frozenset
    weight: float
    description: str


def _c(id_, requires, weight, description):
    return Combo(id_, frozenset(requires), weight, description)


R = Rule

# --------------------------------------------------------------------------- common
COMMON_RULES = [
    R("common.dev_tcp", "execution", 0.90, r"/dev/(?:tcp|udp)/[\w.\-]+/\d+", "Bash /dev/tcp network redirection (reverse shell idiom)"),
    R("common.interactive_shell", "execution", 0.50, r"\b(?:ba|z|da)?sh\s+-i\b", "Interactive shell invocation"),
    R("common.netcat_exec", "execution", 0.85, r"\b(?:nc|ncat|netcat)\b[^\n]*?\s-[a-zA-Z]*e\s+\S+", "netcat with -e (bind/reverse shell)"),
    R("common.curl_pipe_sh", "execution", 0.80, r"\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b", "Downloads and pipes to a shell"),
    R("common.rm_rf_root", "destruction", 0.85, r"\brm\s+(?:-[\w-]+\s+)*-\w*[rR]\w*\s+(?:-[\w-]+\s+)*(?:/\*?|~/?|\$HOME/?)(?=[\s\"';)]|$)", "Recursive delete of / or home"),
    R("common.fork_bomb_sh", "resource_abuse", 0.90, r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:", "Shell fork bomb"),
    R("common.mkfs", "destruction", 0.85, r"\bmkfs(?:\.\w+)?\s+/dev/", "Formats a block device"),
    R("common.dd_device", "destruction", 0.85, r"\bof=/dev/(?:sd|nvme|hd|vd|xvd)\w*", "Writes directly to a block device"),
    R("common.shadow", "credential_access", 0.50, r"/etc/(?:shadow|sudoers)\b", "Reads/writes /etc/shadow or sudoers"),
    R("common.passwd", "credential_access", 0.20, r"/etc/passwd\b", "Touches /etc/passwd"),
    R("common.ssh_keys", "credential_access", 0.50, r"\.ssh/(?:id_\w+|authorized_keys|known_hosts)", "Touches SSH keys"),
    R("common.cloud_creds", "credential_access", 0.45, r"\.aws/credentials|\.kube/config|\.docker/config\.json|\.npmrc\b|\.pypirc\b|\.git-credentials", "Touches cloud/registry credential files"),
    R("common.cloud_metadata", "credential_access", 0.50, r"169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200", "Cloud metadata endpoint"),
    R("common.docker_sock", "privilege", 0.80, r"/var/run/docker\.sock", "Docker socket access (container escape)"),
    R("common.proc_access", "privilege", 0.50, r"/proc/(?:self|1|\d+)/(?:environ|mem|root|maps)\b", "Reads sensitive /proc entries"),
    R("common.cgroup_escape", "privilege", 0.80, r"\brelease_agent\b|\bnotify_on_release\b|/proc/sysrq-trigger", "cgroup / sysrq escape primitives"),
    R("common.miner", "resource_abuse", 0.60, r"stratum\+(?:tcp|ssl)://|\b(?:xmrig|minerd|cpuminer|nicehash)\b", "Crypto-miner indicator"),
    R("common.exfil_endpoint", "exfiltration", 0.50, r"discord(?:app)?\.com/api/webhooks/|api\.telegram\.org/bot|hooks\.slack\.com/services/|pastebin\.com/raw|transfer\.sh|\bngrok(?:-free)?\.(?:io|app|dev)\b|webhook\.site|requestbin|pipedream\.net|interact\.sh|oast\.(?:pro|live|site|online|fun|me)", "Known exfil / callback endpoint"),
    R("common.public_ip", "network", 0.08, r"\b(?!(?:127|10|0|255)\.)(?!192\.168\.)\d{1,3}(?:\.\d{1,3}){3}\b", "Hardcoded public-looking IP address"),
    R("common.long_b64", "obfuscation", 0.25, r"[A-Za-z0-9+/]{200,}={0,2}", "Long base64-like blob"),
    R("common.escaped_bytes", "obfuscation", 0.30, r"(?:\\x[0-9a-fA-F]{2}){24,}", "Long run of escaped bytes (shellcode-like)"),
    R("common.byte_array", "obfuscation", 0.20, r"(?:0x[0-9a-fA-F]{2}\s*,\s*){32,}", "Large literal byte array"),
    R("common.persistence", "persistence", 0.30, r"\bcrontab\s+-|/etc/cron\.|/etc/rc\.local|\bsystemctl\s+enable\b|LaunchAgents|CurrentVersion\\\\?Run\b|\.bashrc\b|\.bash_profile\b|\.zshrc\b", "Persistence location"),
    R("common.disable_security", "evasion", 0.30, r"\b(?:setenforce\s+0|ufw\s+disable|iptables\s+-F|history\s+-c|chattr\s+\+i)", "Disables or tampers with host defences"),
]

# --------------------------------------------------------------------------- python
PYTHON_RULES = [
    R("py.exec_eval", "execution", 0.25, r"\b(?:eval|exec)\s*\(", "Dynamic code execution (eval/exec)"),
    R("py.compile_exec", "execution", 0.20, r"\bcompile\s*\([^)]*['\"]exec['\"]", "compile(..., 'exec')"),
    R("py.decode_exec", "obfuscation", 0.60, r"\b(?:eval|exec)\s*\(\s*(?:base64\.|zlib\.|marshal\.|codecs\.|bytes\.fromhex|binascii\.|__import__|bytearray)", "Executes decoded / decompressed payload"),
    R("py.os_exec", "execution", 0.25, r"\bos\.(?:system|popen|execl|execle|execlp|execlpe|execv|execve|execvp|execvpe|spawn\w+)\s*\(", "os.system / popen / exec* / spawn*"),
    R("py.subprocess_shell", "execution", 0.30, r"\bsubprocess\.\w+\s*\([^)]*shell\s*=\s*True", "subprocess with shell=True"),
    R("py.subprocess", "execution", 0.12, r"\bsubprocess\.(?:run|call|check_call|check_output|Popen)\s*\(", "subprocess call"),
    R("py.pty_spawn", "execution", 0.60, r"\bpty\.spawn\s*\(", "pty.spawn (interactive shell idiom)"),
    R("py.dup2", "execution", 0.50, r"\bos\.dup2\s*\(", "os.dup2 (fd redirection)"),
    R("py.socket", "network", 0.10, r"\bsocket\.(?:socket|create_connection)\s*\(", "Raw socket"),
    R("py.net_fetch", "network", 0.10, r"\b(?:urllib\.request\.(?:urlopen|urlretrieve)|requests\.(?:get|post|put)|httpx\.(?:get|post)|urlretrieve)\s*\(", "Outbound HTTP request"),
    R("py.net_post", "exfiltration", 0.20, r"\b(?:requests|httpx)\.(?:post|put)\s*\(|\burlopen\s*\([^)]*data\s*=", "Outbound POST/PUT"),
    R("py.b64decode", "obfuscation", 0.15, r"\bbase64\.(?:b64|b32|b16|a85|b85|urlsafe_b64)decode\s*\(", "base64 decode"),
    R("py.marshal_loads", "obfuscation", 0.50, r"\bmarshal\.loads?\s*\(", "marshal.load(s)"),
    R("py.pickle_loads", "execution", 0.20, r"\b(?:c?[pP]ickle)\.loads?\s*\(", "pickle.load(s) (arbitrary object construction)"),
    R("py.dynamic_import", "evasion", 0.20, r"\b__import__\s*\(", "__import__()"),
    R("py.builtins_access", "evasion", 0.50, r"\b__builtins__\s*(?:\[|\.)|\bgetattr\s*\(\s*__builtins__", "Reaches builtins indirectly"),
    R("py.getattr_concat", "evasion", 0.20, r"\bgetattr\s*\(\s*[\w.]+\s*,\s*['\"]\w*['\"]\s*\+", "getattr with concatenated name"),
    R("py.chr_chain", "obfuscation", 0.30, r"(?:\bchr\s*\(\s*\d+\s*\)\s*\+\s*){3,}\bchr\s*\(\s*\d+\s*\)", "String built from chr() chain"),
    R("py.ctypes", "execution", 0.20, r"\bctypes\.(?:CDLL|cdll|windll|WinDLL)\b", "Loads native libraries via ctypes"),
    R("py.privilege", "privilege", 0.50, r"\bos\.(?:setuid|setgid|chroot|setresuid)\s*\(", "Privilege / root changes"),
    R("py.fork_bomb", "resource_abuse", 0.85, r"\bwhile\s+(?:True|1)\s*:\s*os\.fork\s*\(", "Fork bomb"),
    R("py.fork", "resource_abuse", 0.20, r"\bos\.fork\s*\(", "os.fork"),
    R("py.env_dump", "credential_access", 0.30, r"\b(?:dict|json\.dumps|str|repr|print)\s*\(\s*os\.environ\s*\)", "Dumps the whole environment"),
    R("py.environ", "credential_access", 0.05, r"\bos\.(?:environ|getenv)\b", "Reads environment variables"),
    R("py.keylogger", "credential_access", 0.40, r"\bfrom\s+pynput\b|\bpynput\.keyboard\b|\bGetAsyncKeyState\b", "Keylogger library"),
    R("py.rmtree_root", "destruction", 0.70, r"\bshutil\.rmtree\s*\(\s*['\"]/['\"]", "rmtree('/')"),
]
PYTHON_COMBOS = [
    _c("py.combo.reverse_shell_dup2", {"py.socket", "py.dup2"}, 0.85, "socket + dup2 (classic reverse shell)"),
    _c("py.combo.reverse_shell_pty", {"py.socket", "py.pty_spawn"}, 0.85, "socket + pty.spawn"),
    _c("py.combo.socket_shell", {"py.socket", "py.subprocess_shell"}, 0.80, "socket + shell=True"),
    _c("py.combo.socket_exec", {"py.socket", "py.os_exec"}, 0.70, "socket + os.system/popen"),
    _c("py.combo.download_exec", {"py.net_fetch", "py.exec_eval"}, 0.60, "download + eval/exec"),
    _c("py.combo.download_run", {"py.net_fetch", "py.os_exec"}, 0.50, "download + run command"),
]

# --------------------------------------------------------------------------- javascript
JS_RULES = [
    R("js.eval", "execution", 0.25, r"\beval\s*\(", "eval()"),
    R("js.new_function", "execution", 0.25, r"\bnew\s+Function\s*\(", "new Function()"),
    R("js.decode_eval", "obfuscation", 0.60, r"\beval\s*\(\s*(?:Buffer\.from|atob)\s*\(", "eval of decoded payload"),
    R("js.child_process", "execution", 0.25, r"require\s*\(\s*['\"](?:node:)?child_process['\"]\s*\)|from\s+['\"](?:node:)?child_process['\"]", "Imports child_process"),
    R("js.exec_call", "execution", 0.30, r"\b(?:execSync|spawnSync|execFileSync)\s*\(|child_process\s*\)?\s*\.\s*(?:exec|spawn|fork|execFile)\s*\(", "Spawns a process"),
    R("js.shell_spawn", "execution", 0.50, r"\bspawn(?:Sync)?\s*\(\s*['\"](?:/bin/)?(?:ba|z|da)?sh['\"]|\bexec(?:Sync)?\s*\(\s*['\"](?:curl|wget|bash|sh)\b", "Spawns a shell / curl / wget"),
    R("js.base64_buffer", "obfuscation", 0.15, r"Buffer\.from\([^)]*['\"](?:base64|hex)['\"]\s*\)|\batob\s*\(", "base64/hex decode"),
    R("js.net", "network", 0.15, r"require\s*\(\s*['\"](?:node:)?(?:net|dgram|tls)['\"]\s*\)|\bnet\.(?:Socket|connect|createConnection)\s*\(", "Raw network sockets"),
    R("js.fetch", "network", 0.08, r"\b(?:fetch|axios\.(?:get|post)|https?\.(?:get|request))\s*\(", "Outbound HTTP request"),
    R("js.env_dump", "credential_access", 0.30, r"JSON\.stringify\s*\(\s*process\.env\s*\)|\bObject\.(?:entries|keys)\s*\(\s*process\.env\s*\)", "Dumps the environment"),
    R("js.env", "credential_access", 0.05, r"\bprocess\.env\b", "Reads environment variables"),
    R("js.vm", "execution", 0.25, r"\bvm\.(?:runIn\w+Context|Script|compileFunction)\b", "vm module code execution"),
    R("js.process_binding", "privilege", 0.50, r"\bprocess\.(?:binding|dlopen)\s*\(", "Native binding access"),
    R("js.fromcharcode", "obfuscation", 0.30, r"String\.fromCharCode\s*\((?:[^),]*,){6,}", "Long fromCharCode chain"),
    R("js.constructor_escape", "evasion", 0.55, r"\bconstructor\s*\.\s*constructor\s*\(|\.constructor\s*\(\s*['\"]return\s+process", "Sandbox escape via constructor"),
    R("js.keylogger", "credential_access", 0.30, r"\b(?:iohook|node-global-key-listener)\b", "Keylogger library"),
]
JS_COMBOS = [
    _c("js.combo.reverse_shell", {"js.net", "js.exec_call"}, 0.85, "net socket + process spawn"),
    _c("js.combo.reverse_shell_sh", {"js.net", "js.shell_spawn"}, 0.85, "net socket + shell spawn"),
    _c("js.combo.download_exec", {"js.fetch", "js.eval"}, 0.60, "fetch + eval"),
    _c("js.combo.download_run", {"js.fetch", "js.shell_spawn"}, 0.60, "fetch + shell spawn"),
]

# --------------------------------------------------------------------------- go
GO_RULES = [
    R("go.exec", "execution", 0.25, r"\bexec\.Command(?:Context)?\s*\(", "os/exec command"),
    R("go.exec_shell", "execution", 0.50, r"\bexec\.Command(?:Context)?\s*\([^\"]*\"(?:sh|bash|/bin/sh|/bin/bash|cmd|cmd\.exe|powershell)\"", "Spawns a shell"),
    R("go.net_dial", "network", 0.20, r"\bnet\.(?:Dial|DialTimeout|Listen)\s*\(", "Raw dial / listen"),
    R("go.syscall", "execution", 0.50, r"\bsyscall\.(?:Exec|ForkExec|Dup2|Dup3|Syscall|RawSyscall|Ptrace\w*)\b", "Low-level syscall use"),
    R("go.remove_root", "destruction", 0.60, r"\bos\.RemoveAll\s*\(\s*\"/", "RemoveAll from /"),
    R("go.http_post", "exfiltration", 0.10, r"\bhttp\.(?:Post|PostForm)\s*\(", "Outbound POST"),
    R("go.plugin", "execution", 0.50, r"\bplugin\.Open\s*\(", "Loads a Go plugin"),
    R("go.unsafe", "evasion", 0.10, r"\"unsafe\"", "unsafe package"),
    R("go.cgo", "execution", 0.10, r"^\s*import\s+\"C\"", "cgo"),
    R("go.base64", "obfuscation", 0.12, r"base64\.(?:Std|URL|RawStd|RawURL)Encoding\.DecodeString\s*\(", "base64 decode"),
    R("go.setuid", "privilege", 0.50, r"\bsyscall\.(?:Setuid|Setgid|Chroot)\s*\(", "Privilege changes"),
]
GO_COMBOS = [
    _c("go.combo.reverse_shell", {"go.net_dial", "go.exec_shell"}, 0.85, "dial + shell spawn"),
    _c("go.combo.reverse_shell_sys", {"go.net_dial", "go.syscall"}, 0.80, "dial + raw syscall"),
]

# --------------------------------------------------------------------------- java
JAVA_RULES = [
    R("java.runtime_exec", "execution", 0.40, r"\bRuntime\.getRuntime\s*\(\s*\)\s*\.\s*exec\s*\(", "Runtime.exec"),
    R("java.processbuilder", "execution", 0.30, r"\bnew\s+ProcessBuilder\s*\(", "ProcessBuilder"),
    R("java.reflection", "evasion", 0.20, r"\bClass\.forName\s*\(", "Class.forName"),
    R("java.set_accessible", "evasion", 0.25, r"\.setAccessible\s*\(\s*true\s*\)|\.getDeclaredMethod\s*\(", "Reflection to bypass access"),
    R("java.classloader", "execution", 0.50, r"\bdefineClass\s*\(|\bnew\s+URLClassLoader\s*\(", "Defines / loads classes at runtime"),
    R("java.socket", "network", 0.20, r"\bnew\s+(?:Server)?Socket\s*\(", "Raw socket"),
    R("java.security_manager", "evasion", 0.40, r"\bSystem\.setSecurityManager\s*\(", "Replaces the SecurityManager"),
    R("java.unsafe", "privilege", 0.50, r"\b(?:sun|jdk\.internal)\.misc\.Unsafe\b", "sun.misc.Unsafe"),
    R("java.deserialize", "execution", 0.25, r"\bnew\s+ObjectInputStream\s*\(", "Java deserialization"),
    R("java.base64", "obfuscation", 0.12, r"\bBase64\.getDecoder\s*\(", "base64 decode"),
    R("java.jni", "execution", 0.30, r"\bSystem\.(?:load|loadLibrary)\s*\(", "Loads native library"),
    R("java.script_engine", "execution", 0.25, r"\bScriptEngineManager\b", "Embedded script engine"),
]
JAVA_COMBOS = [
    _c("java.combo.reverse_shell_rt", {"java.socket", "java.runtime_exec"}, 0.85, "socket + Runtime.exec"),
    _c("java.combo.reverse_shell_pb", {"java.socket", "java.processbuilder"}, 0.85, "socket + ProcessBuilder"),
]

# --------------------------------------------------------------------------- c / c++
NATIVE_RULES = [
    R("native.system", "execution", 0.25, r"\b(?:system|popen)\s*\(", "system() / popen()"),
    R("native.exec", "execution", 0.30, r"\bexec(?:l|le|lp|v|ve|vp|vpe)\s*\(", "exec* family"),
    R("native.dup2", "execution", 0.50, r"\bdup[23]\s*\(", "dup2/dup3 (fd redirection)"),
    R("native.socket", "network", 0.20, r"\bsocket\s*\(\s*(?:AF_INET6?|AF_UNIX|PF_INET)\b", "Raw socket"),
    R("native.fork_bomb", "resource_abuse", 0.85, r"(?:while\s*\(\s*(?:1|true)\s*\)|for\s*\(\s*;\s*;\s*\))\s*\{?\s*fork\s*\(", "Fork bomb"),
    R("native.fork", "resource_abuse", 0.10, r"\bfork\s*\(\s*\)", "fork()"),
    R("native.ptrace", "privilege", 0.50, r"\bptrace\s*\(", "ptrace"),
    R("native.exec_mem", "execution", 0.50, r"\b(?:mmap|mprotect|VirtualProtect|VirtualAlloc)\s*\([^;]*(?:PROT_EXEC|PAGE_EXECUTE\w*)", "Executable memory mapping"),
    R("native.privilege", "privilege", 0.50, r"\b(?:setuid|setgid|setreuid|setresuid|chroot)\s*\(", "Privilege changes"),
    R("native.dlopen", "execution", 0.25, r"\bdlopen\s*\(", "dlopen"),
    R("native.asm", "evasion", 0.20, r"\b(?:__asm__|asm)\s*(?:volatile\s*)?\(", "Inline assembly"),
    R("native.kill_all", "destruction", 0.60, r"\bkill\s*\(\s*-1\s*,", "kill(-1, ...)"),
]
NATIVE_COMBOS = [
    _c("native.combo.reverse_shell", {"native.socket", "native.dup2", "native.exec"}, 0.90, "socket + dup2 + exec"),
    _c("native.combo.socket_dup2", {"native.socket", "native.dup2"}, 0.85, "socket + dup2"),
    _c("native.combo.socket_exec", {"native.socket", "native.exec"}, 0.70, "socket + exec"),
    _c("native.combo.socket_system", {"native.socket", "native.system"}, 0.60, "socket + system()"),
]

# --------------------------------------------------------------------------- rust
RUST_RULES = [
    R("rust.command", "execution", 0.25, r"\bCommand::new\s*\(", "std::process::Command"),
    R("rust.shell", "execution", 0.50, r"\bCommand::new\s*\(\s*\"(?:sh|bash|/bin/sh|/bin/bash|cmd|cmd\.exe|powershell)\"", "Spawns a shell"),
    R("rust.unsafe", "evasion", 0.10, r"\bunsafe\s*\{", "unsafe block"),
    R("rust.libc", "execution", 0.45, r"\blibc::(?:system|fork|execv\w*|dup2|ptrace|setuid|kill|mprotect|mmap)\b", "Raw libc calls"),
    R("rust.tcp", "network", 0.20, r"\b(?:TcpStream::connect|TcpListener::bind|UdpSocket::bind)\s*\(", "Raw network sockets"),
    R("rust.raw_fd", "execution", 0.25, r"\bFromRawFd\b|\bfrom_raw_fd\b", "Constructs handles from raw fds"),
    R("rust.transmute", "evasion", 0.15, r"\bmem::transmute\b", "mem::transmute"),
    R("rust.extern_c", "execution", 0.10, r"\bextern\s+\"C\"", "extern \"C\""),
]
RUST_COMBOS = [
    _c("rust.combo.reverse_shell", {"rust.tcp", "rust.command"}, 0.80, "tcp + Command"),
    _c("rust.combo.tcp_libc", {"rust.tcp", "rust.libc"}, 0.60, "tcp + libc"),
]

# --------------------------------------------------------------------------- registry
ALIASES = {
    "py": "python", "python3": "python",
    "js": "javascript", "node": "javascript", "nodejs": "javascript",
    "golang": "go",
    "c++": "cpp", "cxx": "cpp", "cc": "cpp",
    "rs": "rust",
}
LINE_COMMENT = {
    "python": "#", "javascript": "//", "java": "//", "c": "//", "cpp": "//", "go": "//", "rust": "//",
}
_TABLES = {
    "python": (PYTHON_RULES, PYTHON_COMBOS),
    "javascript": (JS_RULES, JS_COMBOS),
    "go": (GO_RULES, GO_COMBOS),
    "java": (JAVA_RULES, JAVA_COMBOS),
    "c": (NATIVE_RULES, NATIVE_COMBOS),
    "cpp": (NATIVE_RULES, NATIVE_COMBOS),
    "rust": (RUST_RULES, RUST_COMBOS),
}
SUPPORTED_LANGUAGES = tuple(_TABLES)


def normalize_language(language: str | None) -> str:
    lang = (language or "").strip().lower()
    return ALIASES.get(lang, lang)


@lru_cache(maxsize=None)
def get_ruleset(language: str):
    """Return (compiled_rules, combos) for a normalized language. Unknown -> common only."""
    rules, combos = _TABLES.get(language, ([], []))
    compiled = [(r, re.compile(r.pattern, re.MULTILINE)) for r in list(rules) + COMMON_RULES]
    return compiled, list(combos)