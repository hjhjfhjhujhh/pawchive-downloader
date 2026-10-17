#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为本项目生成一对固定的扩展签名密钥，并算出对应的扩展 ID。

产物（默认写到 helper/keys/）：
  private-key.pem        私钥，仅打包签名用，不参与运行，绝不提交（见 .gitignore）
  public-key.der.b64     公钥（DER/SPKI 的 base64），也就是要粘进 manifest.json 的 key
  extension-id.txt       由公钥推导出的扩展 ID（便于人工核对）

算法（已实测 14/14 命中本机已安装扩展）：
  ID = SHA256(base64 解码后的 RSA 公钥 DER) 前 16 字节，每个 nibble 映射 a..p

用法：
  python make_key.py                    # 生成（已存在则拒绝覆盖，除非 --force）
  python make_key.py --print-key        # 只打印当前公钥 base64（不生成）
  python make_key.py --force            # 覆盖重建（会改变扩展 ID！）
"""

import argparse
import base64
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)
KEYS_DIR = os.path.join(HERE, "keys")
PUBLIC_KEY_PATH = os.path.join(KEYS_DIR, "public-key.der.b64")
PRIVATE_KEY_PATH = os.path.join(KEYS_DIR, "private-key.pem")
EXT_ID_PATH = os.path.join(HERE, "extension-id.txt")

_ALPHABET = "abcdefghijklmnop"


def extension_id_from_key(key_b64):
    digest = hashlib.sha256(base64.b64decode(key_b64)).digest()
    out = []
    for byte in digest[:16]:
        out.append(_ALPHABET[byte >> 4])
        out.append(_ALPHABET[byte & 0x0F])
    return "".join(out)


def read_public_key():
    try:
        with open(PUBLIC_KEY_PATH, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except Exception:
        return ""


def generate(force=False):
    if os.path.isfile(PRIVATE_KEY_PATH) and not force:
        sys.stderr.write(
            "私钥已存在，拒绝覆盖：{}\n"
            "（覆盖会改变扩展 ID，需要重跑 install.cmd 并重新加载扩展。确要重建请加 --force）\n".format(
                PRIVATE_KEY_PATH
            )
        )
        return 2

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_der = key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    key_b64 = base64.b64encode(public_der).decode("ascii")

    os.makedirs(KEYS_DIR, exist_ok=True)
    with open(PRIVATE_KEY_PATH, "wb") as handle:
        handle.write(private_pem)
    with open(PUBLIC_KEY_PATH, "w", encoding="utf-8") as handle:
        handle.write(key_b64 + "\n")

    ext_id = extension_id_from_key(key_b64)
    with open(EXT_ID_PATH, "w", encoding="utf-8") as handle:
        handle.write(ext_id + "\n")

    print("已生成密钥对：")
    print("  私钥（勿提交）：{}".format(PRIVATE_KEY_PATH))
    print("  公钥（粘进 manifest.json 的 key）：{}".format(PUBLIC_KEY_PATH))
    print("")
    print("推导出的扩展 ID：{}".format(ext_id))
    print("格式检查：{}".format("合法（32 位 a..p）" if len(ext_id) == 32 else "非法"))
    print("")
    print("manifest.json 里粘贴这一行：")
    print('  "key": "{}",'.format(key_b64))
    return 0


def _generate_with_node(force=False):
    """用 Node 生成密钥对（本项目已有 _unused/keytest/derive-id.mjs）。

    为什么要这条兜底：`cryptography` 不一定装了，而 Node 只是生成密钥用得到，
    不是运行依赖。这里把 Node 当"工具"用，不用就报错说清楚。
    """
    import shutil as _shutil
    import subprocess

    script = os.path.join(PROJECT_ROOT, "_unused", "keytest", "derive-id.mjs")
    if not os.path.isfile(script):
        sys.stderr.write("找不到 {}\n".format(script))
        return 3

    node = _shutil.which("node")
    candidates = [
        node,
        os.path.join(
            os.environ.get("LOCALAPPDATA", ""),
            "Programs", "nodejs", "node.exe",
        ),
        r"C:\Program Files\nodejs\node.exe",
    ]
    node = next((c for c in candidates if c and os.path.isfile(c)), None)
    if not node:
        sys.stderr.write(
            "没找到 node，也没装 cryptography —— 两条生成密钥的路都不可用。\n"
            "任选其一：pip install cryptography  或  安装 Node.js\n"
        )
        return 3

    if os.path.isfile(PRIVATE_KEY_PATH) and not force:
        sys.stderr.write(
            "私钥已存在，拒绝覆盖：{}\n（确要重建请加 --force，注意会改变扩展 ID）\n".format(
                PRIVATE_KEY_PATH
            )
        )
        return 2

    result = subprocess.run(
        [node, script, "generate", KEYS_DIR],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    sys.stdout.write(result.stdout.decode("utf-8", "replace"))
    if result.returncode != 0:
        return result.returncode

    # derive-id.mjs 写的是 manifest-key.txt，改成项目约定的文件名
    manifest_key = os.path.join(KEYS_DIR, "manifest-key.txt")
    key_b64 = ""
    if os.path.isfile(manifest_key):
        with open(manifest_key, "r", encoding="utf-8") as handle:
            key_b64 = handle.read().strip()
        os.replace(manifest_key, PUBLIC_KEY_PATH)

    if not key_b64:
        sys.stderr.write("Node 生成完成，但没读到公钥\n")
        return 3

    ext_id = extension_id_from_key(key_b64)
    with open(EXT_ID_PATH, "w", encoding="utf-8") as handle:
        handle.write(ext_id + "\n")
    print("")
    print("公钥已就位：{}".format(PUBLIC_KEY_PATH))
    print("推导出的扩展 ID：{}".format(ext_id))
    print("")
    print("manifest.json 里粘贴这一行：")
    print('  "key": "{}",'.format(key_b64))
    return 0


def main():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--force", action="store_true", help="覆盖已存在的私钥（会改变扩展 ID）")
    parser.add_argument("--print-key", action="store_true", help="只打印当前公钥 base64")
    args = parser.parse_args()

    if args.print_key:
        key = read_public_key()
        if not key:
            sys.stderr.write("还没有公钥文件：{}\n".format(PUBLIC_KEY_PATH))
            return 2
        print(key)
        print("", file=sys.stderr)
        print("推导出的扩展 ID：{}".format(extension_id_from_key(key)), file=sys.stderr)
        return 0

    try:
        return generate(force=args.force)
    except ImportError:
        print("未安装 cryptography，改用 Node 生成…", file=sys.stderr)
        return _generate_with_node(force=args.force)


if __name__ == "__main__":
    sys.exit(main())
