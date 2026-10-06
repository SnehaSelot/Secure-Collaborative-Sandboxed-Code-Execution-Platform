"""Cheap, dependency-free feature extraction for the Python classifier (Phase 1).

Used by BOTH training (ml/features.py) and inference (risk/engine.py) so they can never drift.
Bump FEATURES_VERSION whenever FEATURE_NAMES or any regex changes; the engine refuses to
use a model trained on a different version.

Count-style features are log1p-scaled. Static regex counts, no AST, so ~1000 lines takes
a few milliseconds.
"""
from __future__ import annotations

import math
import re
from collections import Counter

FEATURES_VERSION = 1

FEATURE_NAMES = [
    # shape / length (watch these in ablations: they are the usual "shortcut" features)
    "log_lines", "log_chars", "log_max_line_len", "mean_line_len",
    # content statistics
    "char_entropy", "non_ascii_ratio", "log_longest_b64_run", "hex_escape_ratio", "comment_ratio",
    # behaviour counts
    "log_exec_eval", "log_shell_exec", "log_network", "log_decode", "log_dyn_import",
    "log_sensitive", "log_url_ip", "log_chr_obf", "log_imports",
]
LENGTH_FEATURES = ["log_lines", "log_chars", "log_max_line_len", "mean_line_len"]

_RE = {
    "exec_eval": re.compile(r"\b(?:eval|exec|compile)\s*\("),
    "shell_exec": re.compile(r"\bos\.(?:system|popen|exec\w*|spawn\w*)\s*\(|\bsubprocess\.\w+|\bpty\.spawn\b|\bcommands\.getoutput\b"),
    "network": re.compile(r"\b(?:socket|requests|urllib|httpx|http\.client|ftplib|smtplib|telnetlib|paramiko|aiohttp)\b"),
    "decode": re.compile(r"\b(?:base64|zlib|marshal|codecs|bz2|lzma|binascii)\.\w+|\bbytes\.fromhex\b|\.decode\s*\(\s*['\"](?:hex|base64|rot13|zlib)"),
    "dyn_import": re.compile(r"__import__|\bimportlib\b|\b(?:getattr|setattr)\s*\(|\b(?:globals|locals|vars)\s*\(\s*\)\s*\[|__builtins__"),
    "sensitive": re.compile(r"\.ssh\b|\.aws\b|/etc/(?:passwd|shadow)|\bos\.environ\b|\bgetpass\b|\bkeyring\b|Login Data|Local State|leveldb|Local Storage"),
    "url_ip": re.compile(r"https?://[^\s'\"]+|\b\d{1,3}(?:\.\d{1,3}){3}\b"),
    "chr_obf": re.compile(r"\bchr\s*\(|\[::-1\]"),
    "imports": re.compile(r"^\s*(?:import|from)\s+\w", re.MULTILINE),
    "b64_run": re.compile(r"[A-Za-z0-9+/=]{20,}"),
    "hex_esc": re.compile(r"\\x[0-9a-fA-F]{2}"),
}


def _entropy(text: str) -> float:
    if not text:
        return 0.0
    counts = Counter(text)
    n = len(text)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def extract(code: str) -> list[float]:
    code = code or ""
    lines = code.split("\n")
    n_lines = max(len(lines), 1)
    n_chars = len(code)
    line_lens = [len(l) for l in lines]
    non_ascii = sum(1 for ch in code if ord(ch) > 127)
    longest_b64 = max((len(m.group(0)) for m in _RE["b64_run"].finditer(code)), default=0)
    comment_lines = sum(1 for l in lines if l.lstrip().startswith("#"))

    def cnt(name: str) -> float:
        return math.log1p(len(_RE[name].findall(code)))

    vec = [
        math.log1p(n_lines),
        math.log1p(n_chars),
        math.log1p(max(line_lens, default=0)),
        n_chars / n_lines,
        _entropy(code[:200_000]),
        non_ascii / max(n_chars, 1),
        math.log1p(longest_b64),
        4 * len(_RE["hex_esc"].findall(code)) / max(n_chars, 1),
        comment_lines / n_lines,
        cnt("exec_eval"), cnt("shell_exec"), cnt("network"), cnt("decode"), cnt("dyn_import"),
        cnt("sensitive"), cnt("url_ip"), cnt("chr_obf"), cnt("imports"),
    ]
    assert len(vec) == len(FEATURE_NAMES)
    return vec
