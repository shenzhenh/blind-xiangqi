"""Start the PvP server for LAN access (phone / another PC).

127.0.0.1 is loopback-only. This launcher binds 0.0.0.0 by default and prints
the LAN URLs so a phone on the same Wi-Fi can open them.

Usage:
    python -m server.serve
    python -m server.serve --port 8000
    python -m server.serve --host 127.0.0.1   # local only

Security: this is still a development server (no auth, CORS *). Use it on a
trusted LAN, or put HTTPS/WSS + auth in front before exposing it publicly.
"""

from __future__ import annotations

import argparse
import socket

import uvicorn


def _candidate_ips() -> list[str]:
    ips: set[str] = set()
    # Primary route (works even when hostname resolution is odd).
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ips.add(s.getsockname()[0])
        finally:
            s.close()
    except OSError:
        pass
    # All hostname addresses, for multi-NIC / VPN machines.
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if ip and not ip.startswith("127."))


def main() -> None:
    parser = argparse.ArgumentParser(description="Blind Xiangqi PvP server (LAN-friendly)")
    parser.add_argument("--host", default="0.0.0.0", help="bind address (default 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8000, help="TCP port (default 8000)")
    args = parser.parse_args()

    print("Blind Xiangqi server")
    print(f"  bind: {args.host}:{args.port}")
    if args.host in ("0.0.0.0", "::"):
        ips = _candidate_ips()
        if ips:
            print("  LAN URLs:")
            for ip in ips:
                print(f"    PvE: http://{ip}:{args.port}/")
                print(f"    PvP: http://{ip}:{args.port}/pvp/")
        else:
            print("  LAN URL: run `ipconfig` and use your IPv4 address.")
        print("  If the phone cannot connect: Windows Firewall must allow")
        print("  Python/this port on the Private network; phone and PC must")
        print("  be on the same Wi-Fi (guest Wi-Fi may isolate clients).")
    else:
        print(f"  local only: http://{args.host}:{args.port}/")
    print()

    uvicorn.run("server.app:app", host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
