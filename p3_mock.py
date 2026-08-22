"""Offline mock connector — fake account + holdings, no network, no keys.
Lets you (and the tests) run the whole bridge and prove the dry-run planning
works before any SnapTrade account exists."""
from __future__ import annotations
from .base import BaseConnector, Account, Holding


class MockConnector(BaseConnector):
    name = "mock"

    def __init__(self, cfg=None):
        self.cfg = cfg

    def connect_url(self) -> str:
        return "https://app.snaptrade.com/connect/EXAMPLE-portal-link (mock — no real link)"

    def list_accounts(self) -> list[Account]:
        return [Account(id="mock-acct-1", name="Stake AUS (demo)", number="STK-000", institution="Stake")]

    def get_holdings(self, account_id: str) -> list[Holding]:
        return [
            Holding(ticker="BHP", qty=50, price=45.20),
            Holding(ticker="GML", qty=1000, price=0.05),
        ]

    def get_cash(self, account_id: str) -> float:
        return 4231.75

    # ---- exit engine surface: an in-memory order book ----
    _orders: dict = {}
    _seq: int = 0

    def get_open_orders(self, account_id: str) -> list[dict]:
        return [dict(o) for o in self._orders.get(account_id, [])]

    def place_stop_sell(self, account_id: str, ticker: str, qty: int, stop_price: float) -> dict:
        MockConnector._seq += 1
        o = {"id": f"mock-ord-{MockConnector._seq}", "ticker": ticker.upper(),
             "action": "SELL", "order_type": "Stop", "stop": float(stop_price), "qty": int(qty)}
        self._orders.setdefault(account_id, []).append(o)
        return dict(o)

    def cancel_order(self, account_id: str, order_id: str) -> dict:
        lst = self._orders.get(account_id, [])
        self._orders[account_id] = [o for o in lst if o["id"] != order_id]
        return {"id": order_id, "cancelled": True}

    # ---- watcher surface: settable quotes + recorded fires ----
    _quotes: dict = {}
    _fires: list = []

    def get_quotes(self, account_id: str, tickers: list[str]) -> dict:
        return {t: dict(self._quotes.get(t) or {}) for t in tickers if t in self._quotes}

    def place_sell(self, account_id: str, ticker: str, qty: int, limit=None) -> dict:
        MockConnector._seq += 1
        o = {"id": f"mock-fire-{MockConnector._seq}", "ticker": ticker.upper(),
             "action": "SELL", "order_type": ("Limit" if limit else "Market"),
             "limit": limit, "qty": int(qty)}
        MockConnector._fires.append(o)
        return dict(o)
