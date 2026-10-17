#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pawchive 安装助手：把「扩展 ID」与「Python 解释器位置」从硬编码里拿出来。

**本脚本刻意不启动任何子进程**——解释器是否真的可用，由调用它的 .cmd 直接运行一次
来判定（退出码就是答案），这样既简单又不受任何捕获管道的限制。

解决两类硬编码：

1. **扩展 ID** —— 不再在 .cmd 里写死一个 32 位字符串。manifest.json 里的 `key`
   已经决定性地绑定了 ID：
       ID = SHA256(base64 解码后的 RSA 公钥 DER) 前 16 字节，每个 nibble 映射 a..p
   该算法已用本机 14 个已安装扩展实测 14/14 命中。这里从 manifest 现算，
   install.cmd 只做「算出来 == 已记录」的自检。

2. **Python 解释器位置** —— 不再写死某个用户目录。脚本只使用 PATH 里的解释器，
   首次成功运行后把它的绝对路径缓存到 python-path.txt，避免浏览器拉起原生消息
   宿主时因 PATH 不同而失效（缓存优先，PATH 兜底，都可在 .cmd 里被 PD_PY 覆盖）。

子命令：
  --print-id                 从 manifest.json 的 key 推导扩展 ID（只输出 ID）
  --check-id [--quiet]       自检 manifest 推导值与 extension-id.txt 是否一致
  --write-id                 把推导值写入 extension-id.txt
  --cache-python <路径>      把 .cmd 解析好的解释器绝对路径写入 python-path.txt
  --cached-python            输出缓存里的解释器路径（没有则退出 3）
  --selftest                 纯计算自检
"""

import base64
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)
MANIFEST_PATH = os.path.join(PROJECT_ROOT, "extension", "manifest.json")
EXT_ID_PATH = os.path.join(HERE, "extension-id.txt")
PY_CACHE_PATH = os.path.join(HERE, "python-path.txt")

_ALPHABET = "abcdefghijklmnop"  # Chrome/Edge 扩展 ID 字母表：nibble -> a..p


# --------------------------------------------------------------------------
# 扩展 ID
# --------------------------------------------------------------------------
def extension_id_from_key(key_b64):
    """扩展 ID = SHA256(base64 解码后的 RSA 公钥 DER) 前 16 字节，nibble -> a..p。"""
    der = base64.b64decode(key_b64)
    digest = hashlib.sha256(der).digest()
    out = []
    for byte in digest[:16]:
        out.append(_ALPHABET[byte >> 4])
        out.append(_ALPHABET[byte & 0x0F])
    return "".join(out)


def derive_id(manifest_path=None):
    """返回当前 manifest 对应的扩展 ID；没有 key 或读取失败时返回 None。"""
    try:
        with open(manifest_path or MANIFEST_PATH, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
    except Exception:
        return None
    key = manifest.get("key")
    if not isinstance(key, str) or not key.strip():
        return None
    try:
        return extension_id_from_key(key)
    except Exception:
        return None


def is_valid_extension_id(value):
    """扩展 ID 必须是 32 位、且只用 a..p 这 16 个字母。"""
    return bool(value) and len(value) == 32 and all(c in _ALPHABET for c in value)


def _read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except Exception:
        return ""


def _write_text(path, value):
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(value.rstrip("\r\n") + "\n")
        return True
    except Exception:
        return False


def expected_id():
    return _read_text(EXT_ID_PATH)


# --------------------------------------------------------------------------
# 子命令
# --------------------------------------------------------------------------
def cmd_print_id():
    value = derive_id()
    if not value:
        sys.stderr.write("无法从 manifest.json 推导扩展 ID（缺少 key？）\n")
        return 2
    if not is_valid_extension_id(value):
        sys.stderr.write("推导出的扩展 ID 格式非法：{!r}\n".format(value))
        return 2
    sys.stdout.write(value)
    return 0


def cmd_check_id(quiet=False):
    derived = derive_id()
    if not derived:
        sys.stderr.write("manifest.json 里没有 key —— 扩展 ID 无法确定\n")
        return 2
    recorded = expected_id()
    if not recorded:
        sys.stderr.write("extension-id.txt 不存在或为空（先跑一次 install.cmd）\n")
        return 2
    if derived != recorded:
        sys.stderr.write(
            "扩展 ID 不一致：manifest 推导 = {} / extension-id.txt = {}\n"
            "-> 说明 manifest 的 key 被换过，或扩展被重新加载成了别的 ID。\n"
            "-> 重跑一次 install.cmd 即可修正（它会用推导值重写 extension-id.txt）。\n".format(
                derived, recorded
            )
        )
        return 1
    if not quiet:
        sys.stdout.write("扩展 ID 一致：{}\n".format(derived))
    return 0


def cmd_write_id():
    derived = derive_id()
    if not derived:
        sys.stderr.write("无法从 manifest.json 推导扩展 ID\n")
        return 2
    if not is_valid_extension_id(derived):
        sys.stderr.write("推导出的扩展 ID 格式非法，拒绝写入：{!r}\n".format(derived))
        return 2
    if not _write_text(EXT_ID_PATH, derived):
        sys.stderr.write("写入 extension-id.txt 失败\n")
        return 2
    sys.stdout.write("已记录扩展 ID：{}\n".format(derived))
    return 0


def cmd_cache_python(path):
    if not path:
        sys.stderr.write("用法：--cache-python <解释器绝对路径>\n")
        return 2
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        sys.stderr.write("不是有效文件：{}\n".format(path))
        return 2
    if not _write_text(PY_CACHE_PATH, path):
        sys.stderr.write("写入 python-path.txt 失败\n")
        return 2
    sys.stdout.write("已缓存 Python 解释器：{}\n".format(path))
    return 0


def cmd_cached_python():
    path = _read_text(PY_CACHE_PATH)
    if not path or not os.path.isfile(path):
        sys.stderr.write("没有可用的缓存解释器\n")
        return 3
    sys.stdout.write(path)
    return 0


def cmd_selftest():
    """纯计算自检，不启动任何子进程；输出只用 ASCII 标记，避免 GBK 控制台编码崩溃。"""
    ok = True

    sample = base64.b64encode(bytes(range(64))).decode("ascii")
    computed = extension_id_from_key(sample)
    print("算法样例 ID: {}".format(computed))
    if len(computed) == 32 and all(c in _ALPHABET for c in computed):
        print("  [OK]   格式合法（32 位 a..p）")
    else:
        print("  [FAIL] 格式非法")
        ok = False
    if extension_id_from_key(sample) != computed:
        print("  [FAIL] 推导不确定")
        ok = False

    public_key_file = os.path.join(HERE, "keys", "public-key.der.b64")
    if os.path.isfile(public_key_file):
        derived = extension_id_from_key(_read_text(public_key_file))
        print("本项目公钥推导 ID: {}".format(derived))
        if derived == "ldigpfmekoeakednbiamcfancpobneaf":
            print("  [OK]   与钉死的扩展 ID 一致")
        else:
            print("  [FAIL] 与钉死的扩展 ID 不一致！")
            ok = False
    else:
        print("（跳过公钥对照：未找到 keys/public-key.der.b64）")

    manifest_derived = derive_id()
    print("manifest.json 推导 ID: {}".format(manifest_derived or "(没有 key)"))
    if not manifest_derived:
        ok = False

    recorded = expected_id()
    print("extension-id.txt 记录: {}".format(recorded or "(空)"))
    cached = _read_text(PY_CACHE_PATH)
    print("python-path.txt 缓存: {}".format(cached or "(空，尚未缓存)"))

    print("自检结果: {}".format("通过" if ok else "失败"))
    return 0 if ok else 1


def main():
    args = sys.argv[1:]
    if not args:
        sys.stderr.write(
            "用法: install_helper.py --print-id | --check-id [--quiet] | --write-id | "
            "--cache-python <路径> | --cached-python | --selftest\n"
        )
        return 2

    if "--print-id" in args:
        return cmd_print_id()
    if "--check-id" in args:
        return cmd_check_id(quiet="--quiet" in args)
    if "--write-id" in args:
        return cmd_write_id()
    if "--cache-python" in args:
        index = args.index("--cache-python")
        value = args[index + 1] if len(args) > index + 1 else ""
        return cmd_cache_python(value)
    if "--cached-python" in args:
        return cmd_cached_python()
    if "--selftest" in args:
        return cmd_selftest()

    sys.stderr.write("未知参数: {}\n".format(" ".join(args)))
    return 2


if __name__ == "__main__":
    sys.exit(main())
