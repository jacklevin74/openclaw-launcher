#!/usr/bin/env python3
"""
TCP proxy: 172.17.0.1:11434 -> 127.0.0.1:11434
Lets Docker containers reach host-only ollama.
"""
import socket, threading, os

LISTEN_HOST = "172.17.0.1"
LISTEN_PORT = 11434
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 11434

def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except:
        pass
    finally:
        try: src.close()
        except: pass
        try: dst.close()
        except: pass

def handle(client):
    try:
        server = socket.create_connection((TARGET_HOST, TARGET_PORT), timeout=10)
    except Exception as e:
        client.close()
        return
    threading.Thread(target=pipe, args=(client, server), daemon=True).start()
    threading.Thread(target=pipe, args=(server, client), daemon=True).start()

def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((LISTEN_HOST, LISTEN_PORT))
    sock.listen(128)
    print(f"Proxying {LISTEN_HOST}:{LISTEN_PORT} -> {TARGET_HOST}:{TARGET_PORT}", flush=True)
    while True:
        client, _ = sock.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()

if __name__ == "__main__":
    main()
