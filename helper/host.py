#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pawchive Downloader 的原生消息宿主 (native messaging host)。

职责只有一件事：保证本机有一个可用的 aria2c RPC 实例，并把
{url, secret, dir, version} 交给扩展。所有下载调度都在扩展里完成。

原生消息协议：每条消息 = 4 字节小端长度 + UTF-8 JSON。
本进程由浏览器启动，stdin/stdout 即为消息通道，因此任何调试输出
都必须写日志文件（--log），绝不能 print 到 stdout。
"""

import json
import os
import random
import shutil
import socket
import string
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

HOST_NAME = "com.pawchive.downloader"
HERE = os.path.dirname(os.path.abspath(__file__))

LOG_PATH = os.path.join(HERE, "host.log")
CONFIG_PATH = os.path.join(HERE, "config.json")
DEFAULT_ARIA2 = os.path.join(HERE, "aria2c.exe")

# 独立模式（被浏览器通过原生消息拉起时，aria2 是浏览器的孙进程，某些机器上
# 会被安全策略限制写盘）。用 --serve 让宿主作为普通进程常驻，aria2 由它直接
# 启动，权限就和用户自己开程序一样。扩展优先走这个 HTTP 桥。
BRIDGE_PORT = 16850
BRIDGE_TOKEN_KEY = "bridgeToken"

DEFAULT_CONFIG = {
    "aria2c": DEFAULT_ARIA2,
    "port": 16800,
    "secret": None,
    "downloadDir": None,
    "staging": None,
    "bridgePort": BRIDGE_PORT,
    "bridgeToken": None,
}


def default_staging_dir():
    """aria2 的临时下载目录。

    为什么不直接下到目标目录：实测 aria2（MinGW 构建）**无法写入映射的网络盘**
    （写入已存在目录报 errorCode=16 Access denied，新建目录报 errorCode=18
    Permission denied），而后端 Python / cmd 写同一个盘完全正常。所以统一让
    aria2 下到本地磁盘，再由宿主把成品移动到目标位置。
    """
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, "PawchiveDownloader", "staging")

_STDIN = sys.stdin.buffer
_STDOUT = sys.stdout.buffer


# --------------------------------------------------------------------------
# 日志 / 配置
# --------------------------------------------------------------------------
def log(message):
    try:
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write("[{}] {}\n".format(stamp, message))
    except Exception:
        pass


def _read_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return dict(fallback)


def load_config():
    stored = _read_json(CONFIG_PATH, DEFAULT_CONFIG)
    config = dict(DEFAULT_CONFIG)
    config.update({k: v for k, v in stored.items() if v is not None})
    if not config.get("secret"):
        config["secret"] = "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(24))
    if not config.get("staging"):
        config["staging"] = default_staging_dir()
    if not config.get(BRIDGE_TOKEN_KEY):
        config[BRIDGE_TOKEN_KEY] = "".join(
            random.choice(string.ascii_lowercase + string.digits) for _ in range(32)
        )
    if not config.get("bridgePort"):
        config["bridgePort"] = BRIDGE_PORT
    return config


def default_download_dir():
    """读取注册表里真实的「下载」文件夹位置，失败则退回 %USERPROFILE%\\Downloads。"""
    try:
        import winreg  # noqa: WPS433 (仅 Windows 需要)

        key_path = (
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
        )
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            raw, _ = winreg.QueryValueEx(key, "{374DE290-123F-4565-9164-39C4925E467B}")
        return os.path.expandvars(raw)
    except Exception:
        return os.path.join(os.path.expanduser("~"), "Downloads")


def is_elevated():
    """当前进程是否以管理员权限运行。

    aria2 缺提升权限时写不了 %LOCALAPPDATA%、%TEMP%、映射盘，甚至桌面目录，
    所以把这条信息暴露给扩展弹窗，便于一眼判断「是不是没提权」。
    """
    try:
        import ctypes

        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def save_config(config):
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as handle:
            json.dump(config, handle, ensure_ascii=False, indent=2)
    except Exception as exc:
        log("save_config failed: {}".format(exc))


def staging_of_instance(config, url):
    """查正在运行的 aria2 实际使用的目录（= staging）。"""
    try:
        options = rpc(url, config["secret"], "aria2.getGlobalOption", timeout=5) or {}
        return options.get("dir")
    except Exception as exc:
        log("staging_of_instance failed: {}".format(exc))
        return None


# --------------------------------------------------------------------------
# aria2 RPC
# --------------------------------------------------------------------------
class Aria2Error(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def rpc(url, secret, method, params=None, timeout=5):
    payload = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": "host",
            "method": method,
            "params": ["token:{}".format(secret)] + list(params or []),
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise Aria2Error("HTTP {}".format(exc.code))
    except Exception as exc:
        raise Aria2Error(str(exc))
    if isinstance(body, dict) and body.get("error"):
        error = body["error"]
        raise Aria2Error(error.get("message", "rpc error"), error.get("code"))
    return body.get("result")


def probe(url, secret, timeout=2):
    """探测某个 URL 上是否已有属于本宿主的 aria2 实例。"""
    try:
        version = rpc(url, secret, "aria2.getVersion", timeout=timeout)
    except Exception:
        return None
    if not isinstance(version, dict):
        return None
    return version


def port_is_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True

def find_aria2(config):
    """按优先级找一个可用的 aria2c.exe。

    这里刻意**不再包含任何开发机专属路径**（曾经写过
    `~/Desktop/webExtensions/pawchiveDownloader2/...` 之类，换台机器就是死路径）。
    现在的顺序是：config.json 指定 -> 随 helper 一起分发的位置 -> 用户级安装位置
    -> PATH -> 项目自带的 _unused 参考包。
    想固定用某个二进制，直接改 config.json 的 "aria2c" 字段即可。
    """
    candidates = []
    if config.get("aria2c"):
        candidates.append(config["aria2c"])
    candidates.append(DEFAULT_ARIA2)

    project_root = os.path.dirname(HERE)
    local_appdata = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    for base in (
        HERE,
        os.path.join(local_appdata, "PawchiveDownloader"),  # 便携/绿色安装的常见落点
        os.path.join(project_root, "_unused", "aria2-1.37.0"),
        os.path.join(project_root, "aria2-1.37.0"),
    ):
        candidates.append(os.path.join(base, "aria2c.exe"))
        candidates.append(os.path.join(base, "aria2-1.37.0", "aria2c.exe"))

    from_path = shutil.which("aria2c.exe") or shutil.which("aria2c")
    if from_path:
        candidates.append(from_path)

    seen = set()
    for candidate in candidates:
        if not candidate:
            continue
        normalized = os.path.normcase(os.path.abspath(candidate))
        if normalized in seen:
            continue
        seen.add(normalized)
        if os.path.isfile(candidate):
            return candidate
    return None


def spawn_aria2(config, staging_dir):
    exe = find_aria2(config)
    if not exe:
        raise Aria2Error(
            "找不到 aria2c.exe，请把它放到 {} 或修改 config.json 里的 aria2c 路径".format(HERE)
        )
    os.makedirs(staging_dir, exist_ok=True)

    start_port = int(config.get("port") or 16800)
    last_error = None
    for offset in range(0, 10):
        port = start_port + offset
        if not port_is_free(port):
            continue
        url = "http://127.0.0.1:{}/jsonrpc".format(port)
        # 端口上可能已经有本宿主的实例（config 丢失时），先复用。
        existing = probe(url, config["secret"])
        if existing:
            config["port"] = port
            save_config(config)
            return {
                "url": url,
                "secret": config["secret"],
                "staging": staging_dir,
                "version": existing.get("version"),
                "port": port,
            }

        log_path = os.path.join(HERE, "aria2.{}.log".format(port))
        args = [
            exe,
            "--enable-rpc",
            "--rpc-listen-all=false",
            "--rpc-allow-origin-all=true",
            "--rpc-listen-port={}".format(port),
            "--rpc-secret={}".format(config["secret"]),
            "--dir={}".format(staging_dir),
            "--continue=true",
            "--allow-overwrite=false",
            "--auto-file-renaming=true",
            "--max-tries=5",
            "--retry-wait=2",
            "--timeout=30",
            "--connect-timeout=15",
            "--max-connection-per-server=8",
            "--split=8",
            "--min-split-size=1M",
            "--file-allocation=none",
            "--check-certificate=false",
            "--content-disposition=false",
            "--summary-interval=0",
            "--console-log-level=warn",
            "--log={}".format(log_path),
            "--log-level=warn",
        ]
        creationflags = 0
        if hasattr(subprocess, "DETACHED_PROCESS"):
            creationflags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        try:
            subprocess.Popen(
                args,
                cwd=HERE,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=creationflags,
                close_fds=True,
            )
        except Exception as exc:
            last_error = "启动 aria2c 失败: {}".format(exc)
            continue

        deadline = time.time() + 12
        while time.time() < deadline:
            version = probe(url, config["secret"])
            if version:
                config["port"] = port
                save_config(config)
                log("aria2c started on port {} ({})".format(port, version.get("version")))
                return {
                    "url": url,
                    "secret": config["secret"],
                    "staging": staging_dir,
                    "version": version.get("version"),
                    "port": port,
                }
            time.sleep(0.3)
        last_error = "aria2c 在端口 {} 上启动后 12 秒内没有响应".format(port)

    raise Aria2Error(last_error or "无法启动 aria2c")


def aria2_can_write(url, secret, directory):
    """让 aria2 自己往目标目录写一个文件，判断它是否真的写得进去。

    为什么不用 Python 的写测试：实测两者结论会不一致 —— Python 能写的目录，
    aria2（缺提升权限时）会报 Access denied。宿主能写不代表下载能落盘。

    实现用 aria2.saveSession 写到该目录下的探针文件：语义明确，且不改动
    正在运行的实例的 dir / log 设置（只临时换一下 save-session，随后还原）。
    """
    try:
        os.makedirs(directory, exist_ok=True)
        probe_path = os.path.join(directory, ".pd-write-probe.session")
        try:
            os.remove(probe_path)
        except OSError:
            pass

        previous = ""
        try:
            options = rpc(url, secret, "aria2.getGlobalOption", timeout=6) or {}
            previous = options.get("save-session") or ""
        except Exception:
            previous = ""

        rpc(
            url,
            secret,
            "aria2.changeGlobalOption",
            [{"save-session": probe_path}],
            timeout=6,
        )
        rpc(url, secret, "aria2.saveSession", timeout=6)
        written = os.path.exists(probe_path)

        # 还原（并且把这次探测留下的空会话文件清掉）
        try:
            rpc(
                url,
                secret,
                "aria2.changeGlobalOption",
                [{"save-session": previous}],
                timeout=6,
            )
        except Exception:
            pass
        try:
            os.remove(probe_path)
        except OSError:
            pass

        if written:
            log("aria2 write probe OK: {}".format(directory))
        return written
    except Exception as exc:
        log("aria2 write probe failed for {}: {}".format(directory, exc))
        return False


_STAGING_CACHE = {"dir": None, "candidates": [], "at": 0.0, "url": ""}


def pick_staging_dir(config, url, secret, user_download_dir, extra_first=None):
    """挑一个 aria2 真的能写的 staging 目录（逐个候选实测）。

    候选顺序里把「aria2 当前实际使用的目录」放最前面：它可写就继续用，
    不可写才换地方（换地方要重启 aria2）。这样才不会出现
    「复用了实例，但它用的目录其实写不进去」。

    结果会缓存下来给 diagnose 复用 —— 失败候选每个都要等一次 RPC 超时，
    不缓存的话每点一次「检测可写性」都要重跑一遍，很慢。
    """
    cached = _STAGING_CACHE
    if cached["dir"] and (time.time() - cached["at"]) < 300:
        if cached.get("url") == url:
            return cached["dir"]

    candidates = []
    for candidate in (
        extra_first,
        config.get("staging"),
        default_staging_dir(),
        os.path.join(os.environ.get("TEMP") or "/tmp", "PawchiveDownloader", "staging"),
        os.path.join(user_download_dir, ".pd-staging") if user_download_dir else None,
    ):
        if candidate:
            path = os.path.abspath(os.path.expandvars(os.path.expanduser(candidate)))
            if path not in candidates:
                candidates.append(path)

    first_ok = None
    probed = []
    for path in candidates:
        try:
            os.makedirs(path, exist_ok=True)
        except Exception as exc:
            log("staging mkdir failed ({}): {}".format(path, exc))
            probed.append({"path": path, "aria2Writable": False})
            continue
        writable = aria2_can_write(url, secret, path)
        probed.append({"path": path, "aria2Writable": writable})
        if writable:
            # 当前实际使用的目录可写 —— 最优，直接沿用
            if extra_first and os.path.normcase(path) == os.path.normcase(extra_first):
                _STAGING_CACHE.update(
                    {"dir": path, "candidates": probed, "at": time.time(), "url": url}
                )
                return path
            if first_ok is None:
                first_ok = path
        else:
            log("staging not writable by aria2: {}".format(path))

    chosen = first_ok or os.path.abspath(config.get("staging") or default_staging_dir())
    _STAGING_CACHE.update(
        {"dir": chosen, "candidates": probed, "at": time.time(), "url": url}
    )
    return chosen


def running_aria2(config):
    """找出本宿主之前拉起的 aria2 实例（同密钥即可确认）。"""
    for offset in range(0, 10):
        port = int(config.get("port") or 16800) + offset
        url = "http://127.0.0.1:{}/jsonrpc".format(port)
        version = probe(url, config["secret"])
        if not version:
            continue
        running_dir = None
        try:
            global_option = rpc(url, config["secret"], "aria2.getGlobalOption") or {}
            running_dir = global_option.get("dir")
        except Exception as exc:
            log("getGlobalOption failed: {}".format(exc))
        return {"port": port, "url": url, "version": version, "running_dir": running_dir}
    return None


def stop_instance(url, secret, wait_seconds=12):
    try:
        rpc(url, secret, "aria2.shutdown")
    except Exception as exc:
        log("shutdown failed: {}".format(exc))
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        time.sleep(0.25)
        if probe(url, secret, timeout=1) is None:
            return True
    log("aria2 did not exit in time: {}".format(url))
    return False


def handle_start(payload):
    config = load_config()
    download_dir = (
        payload.get("downloadDir")
        or config.get("downloadDir")
        or default_download_dir()
    )
    download_dir = os.path.abspath(os.path.expandvars(os.path.expanduser(download_dir)))
    if config.get("downloadDir") != download_dir:
        config["downloadDir"] = download_dir
        save_config(config)

    exe = find_aria2(config)
    if not exe:
        raise Aria2Error(
            "找不到 aria2c.exe（已查找 {} 及常见位置）".format(DEFAULT_ARIA2)
        )
    config["aria2c"] = exe
    save_config(config)

    # 已有实例？先记下来（staging 探测需要一个活着的 RPC 来做 aria2 级写入测试）
    running = running_aria2(config)
    if running:
        config["port"] = running["port"]
        save_config(config)

    def do_start(root):
        result = spawn_aria2(config, root)
        result.update({"ok": True, "reused": False, "aria2c": exe, "dir": download_dir})
        return result

    def respond(instance, staging):
        return {
            "ok": True,
            "reused": True,
            "url": instance["url"],
            "secret": config["secret"],
            "dir": download_dir,
            "staging": staging,
            "version": instance["version"].get("version"),
            "port": instance["port"],
            "aria2c": exe,
        }

    if not running:
        return do_start(config.get("staging") or default_staging_dir())

    staging = pick_staging_dir(
        config, running["url"], config["secret"], download_dir, extra_first=running["running_dir"]
    )
    # 关键：不要复用「写不进任何目录」的实例。典型场景是扩展先以普通权限拉起了
    # 一个 aria2，之后用户用管理员权限起了本辅助程序 —— 那个旧实例依然没提权，
    # 复用它只会继续报 Permission denied。此时先把它结束掉再重新启动。
    probed = _STAGING_CACHE.get("candidates") or []
    usable = any(c.get("aria2Writable") for c in probed)
    if not usable:
        log("existing aria2 cannot write anywhere -> restarting it")
        if stop_instance(running["url"], config["secret"]):
            _STAGING_CACHE.update({"dir": None, "candidates": [], "at": 0.0, "url": ""})
            result = do_start(staging)
            actual = staging_of_instance(config, result["url"])
            if actual:
                result["staging"] = actual
            return result
        return {
            "ok": False,
            "error": (
                "现有 aria2 实例写不了任何目录，且当前宿主权限不足以结束它。"
                "请手动结束残留的 aria2c.exe，再用管理员权限运行 helper\\run-as-admin.cmd。"
            ),
            "runningDir": running["running_dir"],
        }

    if config.get("staging") != staging:
        log("staging selected: {} (was {})".format(staging, config.get("staging")))
        config["staging"] = staging
        save_config(config)

    same_dir = False
    if running["running_dir"]:
        same_dir = os.path.normcase(os.path.abspath(running["running_dir"])) == os.path.normcase(staging)

    if same_dir:
        return respond(running, staging)

    log("restarting aria2: staging {} -> {}".format(running["running_dir"], staging))
    if not stop_instance(running["url"], secret):
        # 关不掉通常是权限不匹配：既有实例是管理员起的，而当前宿主是普通权限
        # （浏览器通过原生消息拉起的就是普通权限）。此时不要再启一个，
        # 否则端口打架；直接把原因告诉扩展。
        return {
            "ok": False,
            "error": (
                "无法重启 aria2：正在运行的实例权限高于当前宿主。"
                "请关闭 run-as-admin.cmd 窗口后重试，或用管理员权限重新运行它。"
            ),
            "runningDir": running["running_dir"],
            "staging": staging,
        }
    result = do_start(staging)
    # 回读真实生效的目录：万一 aria2 内部没换成功，前端能立刻看出来
    actual = staging_of_instance(config, result["url"])
    if actual:
        result["staging"] = actual
        if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(staging):
            log("WARNING: aria2 running dir is {} but staging was {}".format(actual, staging))
    return result


def handle_move(payload):
    """把 aria2 下载好的文件从 staging 搬到最终归档目录。

    网络盘（映射的 Z: 之类）aria2 写不进去，但本进程可以，所以搬运在这一层做。
    """
    config = load_config()
    staging = os.path.abspath(config.get("staging") or default_staging_dir())
    download_dir = os.path.abspath(
        payload.get("downloadDir") or config.get("downloadDir") or default_download_dir()
    )
    rel = str(payload.get("rel") or "").strip().strip("/\\")
    if not rel:
        raise Aria2Error("缺少目标相对路径")

    dest = os.path.abspath(os.path.join(download_dir, *rel.split("/")))
    # 防目录穿越
    if not dest.startswith(download_dir + os.sep):
        raise Aria2Error("目标路径越界: {}".format(rel))

    source = os.path.abspath(
        os.path.join(staging, *rel.split("/"))
    )
    if not source.startswith(staging + os.sep):
        raise Aria2Error("源路径越界: {}".format(rel))

    # 兼容「aria2 实际下到了 staging 根目录」以及「相对 dir 落到别处」的情况：
    # 按文件名在 staging 下递归找一次。
    if not os.path.isfile(source):
        flat = os.path.join(staging, os.path.basename(rel))
        if os.path.isfile(flat):
            source = flat
    if not os.path.isfile(source):
        wanted = os.path.basename(rel)
        for root, _dirs, files in os.walk(staging):
            if wanted in files:
                source = os.path.join(root, wanted)
                break

    if not os.path.isfile(source):
        raise Aria2Error("staging 中找不到文件: {}".format(source))

    size = os.path.getsize(source)
    dest_dir = os.path.dirname(dest)
    last_error = None
    for attempt in range(1, 4):
        try:
            if dest_dir:
                os.makedirs(dest_dir, exist_ok=True)
            target = dest
            # 已存在就改名，绝不覆盖
            if os.path.exists(target):
                stem, ext = os.path.splitext(os.path.basename(dest))
                for index in range(1, 1000):
                    candidate = os.path.join(dest_dir, "{} ({}){}".format(stem, index, ext))
                    if not os.path.exists(candidate):
                        target = candidate
                        break
            try:
                os.replace(source, target)
            except OSError:
                import shutil

                shutil.move(source, target)
            return {
                "ok": True,
                "path": target,
                "size": size,
                "renamed": target != dest,
            }
        except Exception as exc:  # noqa: BLE001 网络盘可能瞬时不可用，重试
            last_error = exc
            log("move attempt {} failed: {} -> {}: {}".format(attempt, source, dest, exc))
            time.sleep(0.8 * attempt)

    raise Aria2Error("移动文件失败: {}（{}）".format(rel, last_error))


def handle_cleanup(payload):
    """清理 staging 中的空目录与残留 .aria2 控制文件。"""
    config = load_config()
    staging = os.path.abspath(config.get("staging") or default_staging_dir())
    removed = 0
    try:
        for root, dirs, files in os.walk(staging, topdown=False):
            for name in files:
                if name.endswith(".aria2"):
                    try:
                        os.remove(os.path.join(root, name))
                        removed += 1
                    except OSError:
                        pass
            for name in dirs:
                path = os.path.join(root, name)
                try:
                    if not os.listdir(path):
                        os.rmdir(path)
                except OSError:
                    pass
    except Exception as exc:
        log("cleanup failed: {}".format(exc))
    return {"ok": True, "removed": removed, "staging": staging}


def handle_bridge_info(payload):
    """只返回桥接信息（地址 + 令牌），绝不启动 aria2。

    扩展用原生消息调用它来获取令牌 —— 原生消息宿主是浏览器拉起的、权限普通，
    但它读得到 config.json。真正的启动/下载一律走桥（管理员权限）。
    """
    config = load_config()
    info = {"ok": True, "bridgeRunning": True}
    info.update(bridge_info(config))
    info["downloadDir"] = config.get("downloadDir")
    info["elevated"] = is_elevated()
    return info


def handle_status(payload):
    config = load_config()
    port = int(config.get("port") or 16800)
    url = "http://127.0.0.1:{}/jsonrpc".format(port)
    version = probe(url, config["secret"])
    if not version:
        return {"ok": True, "running": False, "port": port, "staging": config.get("staging")}
    return {
        "ok": True,
        "running": True,
        "url": url,
        "secret": config["secret"],
        "version": version.get("version"),
        "port": port,
        "staging": staging_of_instance(config, url) or config.get("staging"),
        "dir": config.get("downloadDir"),
    }


def handle_diagnose(payload):
    """诊断：列出 staging 候选并逐个用 aria2 实测能否写入。

    给弹窗用，方便一眼看出「aria2 到底写不写得进这个盘」——
    注意宿主（Python）能写 != aria2 能写，必须让 aria2 自己写一次。
    结果优先复用 pick_staging_dir 刚做过的探测（失败候选每个都要等超时，很慢）。
    """
    config = load_config()
    running = running_aria2(config)
    info = {
        "ok": True,
        "config": {
            "downloadDir": config.get("downloadDir"),
            "staging": config.get("staging"),
            "port": config.get("port"),
            "aria2c": config.get("aria2c"),
        },
        "running": bool(running),
        "runtimeDir": running["running_dir"] if running else None,
        "candidates": [],
        # 注意：这只是「桥进程」的权限。真正决定成败的是 aria2 进程能否写盘，
        # 而两者可能不一致（桥提权了，但复用到的是之前没提权的旧 aria2 实例）。
        # 所以判定一律以 candidates 里的实测结果为准，这个字段只作参考。
        "bridgeElevated": is_elevated(),
    }
    if not running:
        info["hint"] = "aria2 未运行，先启动引擎再诊断"
        return info

    cached = _STAGING_CACHE
    if cached.get("candidates") and cached.get("url") == running["url"]:
        info["candidates"] = cached["candidates"]
    else:
        seen = []
        for candidate in (
            running["running_dir"],
            config.get("staging"),
            default_staging_dir(),
            os.path.join(os.environ.get("TEMP") or "/tmp", "PawchiveDownloader", "staging"),
            os.path.join(config.get("downloadDir") or default_download_dir(), ".pd-staging"),
        ):
            if not candidate:
                continue
            path = os.path.abspath(os.path.expandvars(os.path.expanduser(candidate)))
            if path in seen:
                continue
            seen.append(path)
            writable = aria2_can_write(running["url"], config["secret"], path)
            info["candidates"].append({"path": path, "aria2Writable": writable})

    if info["candidates"] and all(not c["aria2Writable"] for c in info["candidates"]):
        info["hint"] = (
            "aria2 写不了任何候选目录（实测 errorCode=18 Permission denied）。"
            "真正的原因是 aria2 缺少提升权限，而不是目录 ACL。"
            "请关闭当前辅助程序与残留的 aria2c.exe，然后用管理员权限运行 "
            "helper\\run-as-admin.cmd，再重新点「启动 aria2」。"
            "注意：复用一个没提权的旧 aria2 实例不会解决问题。"
        )
    return info


def handle_stop(payload):
    config = load_config()
    port = int(config.get("port") or 16800)
    url = "http://127.0.0.1:{}/jsonrpc".format(port)
    try:
        rpc(url, config["secret"], "aria2.shutdown")
    except Exception as exc:
        log("shutdown failed: {}".format(exc))
    return {"ok": True}


HANDLERS = {
    "start": handle_start,
    "status": handle_status,
    "stop": handle_stop,
    "move": handle_move,
    "cleanup": handle_cleanup,
    "diagnose": handle_diagnose,
    "bridge_info": handle_bridge_info,
}


def read_message():
    header = _STDIN.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("<I", header)
    if length == 0:
        return None
    body = b""
    while len(body) < length:
        chunk = _STDIN.read(length - len(body))
        if not chunk:
            return None
        body += chunk
    return json.loads(body.decode("utf-8"))


def write_message(payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    _STDOUT.write(struct.pack("<I", len(data)))
    _STDOUT.write(data)
    _STDOUT.flush()


def bridge_info(config):
    """给扩展的桥接信息（地址 + 令牌）。"""
    return {
        "bridgeUrl": "http://127.0.0.1:{}/rpc".format(config.get("bridgePort") or BRIDGE_PORT),
        "bridgeToken": config.get(BRIDGE_TOKEN_KEY),
        "bridgePort": config.get("bridgePort") or BRIDGE_PORT,
    }


def dispatch(action, payload, via="stdio"):
    """按 action 分发（两条入口共用：原生消息 & HTTP 桥）。

    via="stdio" 表示这是浏览器通过原生消息拉起的临时宿主：**禁止它启动 aria2**。
    因为浏览器拉起的进程是普通权限，它启动的 aria2 写不了 %LOCALAPPDATA%、
    %TEMP%、映射盘等目录，只会制造「创建目录或打开文件失败」。
    aria2 必须由独立模式（管理员权限的宿主）启动。
    """
    if via == "stdio" and action == "start":
        return {
            "ok": False,
            "error": (
                "已禁用「浏览器拉起 aria2」：这样启动的 aria2 没有提升权限，写盘会失败。"
                "请双击 helper\\run-as-admin.cmd（UAC 点「是」）并保持窗口打开，然后重试。"
            ),
            "needBridge": True,
        }
    handler = HANDLERS.get(action)
    if handler is None:
        return {"ok": False, "error": "未知命令: {}".format(action)}
    try:
        return handler(payload)
    except Aria2Error as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        log("handler {} crashed: {}".format(action, exc))
        return {"ok": False, "error": "{}: {}".format(type(exc).__name__, exc)}


def serve_bridge():
    """独立 HTTP 桥：普通进程常驻，由它直接启动 aria2。

    这样 aria2 的父进程就是用户自己启动的程序，不再挂在浏览器进程树下，
    可以避开「浏览器孙进程被安全策略限制写盘」的问题。
    """
    import http.server
    
    config = load_config()
    save_config(config)
    port = int(config.get("bridgePort") or BRIDGE_PORT)
    token = config.get(BRIDGE_TOKEN_KEY)

    class BridgeHandler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "PawchiveBridge/1.0"

        def log_message(self, fmt, *args):  # 静音，避免刷屏
            pass

        def _send(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            try:
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                # 扩展的 SW 从 chrome-extension:// 发请求过来，属跨域，必须放行
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception:
                pass

        def do_OPTIONS(self):
            try:
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
                self.send_header("Content-Length", "0")
                self.end_headers()
            except Exception:
                pass

        def do_GET(self):
            if self.path.startswith("/ping"):
                self._send(200, {"ok": True, "service": "pawchive-bridge", "port": port})
            else:
                self._send(404, {"ok": False, "error": "not found"})

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                message = json.loads(raw.decode("utf-8"))
            except Exception as exc:
                self._send(400, {"ok": False, "error": "bad request: {}".format(exc)})
                return

            if token and message.get("token") != token:
                self._send(403, {"ok": False, "error": "令牌无效"})
                return

            action = message.get("action") or ""
            result = dispatch(action, message, via="bridge")
            if isinstance(result, dict):
                result.setdefault("via", "bridge")
            self._send(200, result)

    # 端口被占：先看是不是已经在跑的桥
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe_sock:
            probe_sock.settimeout(2)
            probe_sock.connect(("127.0.0.1", port))
        log("bridge port {} already in use — 可能已有一个桥在运行".format(port))
        print("端口 {} 已被占用：可能已经有一个 Pawchive 辅助程序在运行。".format(port))
        return
    except OSError:
        pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), BridgeHandler)
    server.daemon_threads = True
    log("bridge listening on 127.0.0.1:{}".format(port))
    print("=" * 62)
    print(" Pawchive 下载辅助程序已启动（独立模式）")
    print("   监听：http://127.0.0.1:{}/".format(port))
    print("   aria2 将由本进程直接启动，不再挂在浏览器进程树下。")
    print("   这个窗口保持打开即可；关闭窗口 = 停止辅助程序。")
    print("=" * 62)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        log("bridge stopped")


def main():
    if "--serve" in sys.argv or "serve" in sys.argv:
        serve_bridge()
        return

    log("host started (pid {})".format(os.getpid()))
    while True:
        try:
            message = read_message()
        except Exception as exc:
            log("read failed: {}".format(exc))
            break
        if message is None:
            break
        action = message.get("action")
        result = dispatch(action, message, via="stdio")
        # 顺带把桥接信息带上，扩展就知道该用哪种方式跟宿主说话
        if isinstance(result, dict) and action in ("start", "status", "bridge_info"):
            try:
                result.update(bridge_info(load_config()))
            except Exception:
                pass
        try:
            write_message(result)
        except Exception as exc:
            log("write failed: {}".format(exc))
            break
    log("host exiting")


if __name__ == "__main__":
    main()
