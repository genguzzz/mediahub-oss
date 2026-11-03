"""插件的协程工具。

MoviePilot 的 FastAPI 把同步接口放进进程共用的线程池（约 40 个线程），一个请求占一个线程直到返回。插件的接口要连
115 / OpenList / Emby / Prowlarr，慢起来几秒到几十秒，一并发就把这个池子占满，MoviePilot 所有接口一起超时
（2026-11-04 一次按来源搜 18 个请求 + 长轮询就这样「挂了」）。所以：
- 插件的同步接口一律包成 async（to_async），同步部分放进插件自己的线程池 IO，占满也只影响插件自己；
- 搜索这种纯网络扇出直接用协程：httpx.AsyncClient 并发请求，等待不占线程。
"""
import asyncio
import functools
import inspect
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict

import httpx

IO = ThreadPoolExecutor(max_workers=16, thread_name_prefix="p115-io")


async def run(fn: Callable, *a: Any, **k: Any) -> Any:
    """在插件线程池里跑一个同步函数（阻塞的 HTTP / 数据库 / MP 的同步接口）。"""
    return await asyncio.get_running_loop().run_in_executor(IO, functools.partial(fn, *a, **k))


def to_async(fn: Callable) -> Callable:
    """同步接口 → async 接口（参数签名不变，FastAPI 照常解析 query/body）。已经是 async 的原样返回。"""
    if inspect.iscoroutinefunction(fn):
        return fn

    @functools.wraps(fn)
    async def endpoint(*a: Any, **k: Any) -> Any:
        return await run(fn, *a, **k)
    return endpoint


_clients: Dict[int, httpx.AsyncClient] = {}
_sems: Dict[int, asyncio.Semaphore] = {}


def client() -> httpx.AsyncClient:
    """当前事件循环的共用 HTTP 客户端（连接复用）。不读代理环境变量：Prowlarr 在内网（docker 网关）。"""
    loop = id(asyncio.get_running_loop())
    c = _clients.get(loop)
    if c is None or c.is_closed:
        c = _clients[loop] = httpx.AsyncClient(trust_env=False, timeout=60,
                                               limits=httpx.Limits(max_connections=32, max_keepalive_connections=16))
    return c


def prowlarr_slot() -> asyncio.Semaphore:
    """单索引器查询的并发上限（所有搜索合计）：Prowlarr 跑在 2G 内存的 NAS 上。"""
    loop = id(asyncio.get_running_loop())
    s = _sems.get(loop)
    if s is None:
        s = _sems[loop] = asyncio.Semaphore(12)
    return s
