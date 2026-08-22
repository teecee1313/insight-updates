"""The connector contract. Any broker route must implement these. Keeping this
tiny and explicit is what makes the broker swappable."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional


@dataclass
class Account:
    id: str
    name: str
    number: str = ""
    institution: str = ""


@dataclass
class Holding:
    ticker: str
    qty: float
    price: Optional[float] = None
    currency: str = "AUD"

    @property
    def value(self) -> Optional[float]:
        return round(self.qty * self.price, 2) if self.price is not None else None


class BaseConnector:
    name = "base"

    # ---- Phase 0: read-only ----
    def connect_url(self) -> str:
        """Return a one-time secure URL to link the brokerage (Connection Portal)."""
        raise NotImplementedError

    def list_accounts(self) -> list[Account]:
        raise NotImplementedError

    def get_holdings(self, account_id: str) -> list[Holding]:
        raise NotImplementedError

    def get_cash(self, account_id: str) -> float:
        raise NotImplementedError

    # ---- Phase 2+: trading (defined now, used later, gated by the safety engine) ----
    # ---- exit engine surface (phase 2) ----
    def get_open_orders(self, account_id: str) -> list[dict]:
        """Open orders as dicts: id, ticker, action, order_type, stop, qty."""
        raise NotImplementedError

    def place_stop_sell(self, account_id: str, ticker: str, qty: int, stop_price: float) -> dict:
        """Rest a Stop SELL at the broker. Returns dict with the broker order id."""
        raise NotImplementedError

    def cancel_order(self, account_id: str, order_id: str) -> dict:
        raise NotImplementedError

    def place_order(self, account_id: str, order) -> dict:
        raise NotImplementedError("trading is not enabled in Phase 0")
