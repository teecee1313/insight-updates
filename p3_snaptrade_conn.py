"""
SnapTrade connector. Uses the official `snaptrade-python-sdk`.

SnapTrade is the sanctioned pipe to Stake: you link Stake once through SnapTrade's
own secure screen, so your Stake password NEVER touches this program. This class
only ever holds your SnapTrade keys (from env) — never a broker password.

Phase 0 methods (connect / list_accounts / get_holdings / get_cash) are all
READ-ONLY. place_order is written for Phase 2 but is only ever reached AFTER the
safety engine says so, and never in DRY_RUN.
"""
from __future__ import annotations
from .base import BaseConnector, Account, Holding


def _body(resp):
    """Konfig SDK responses expose the payload on .body; fall back gracefully."""
    return getattr(resp, "body", resp)


class SnapTradeConnector(BaseConnector):
    name = "snaptrade"

    def __init__(self, cfg):
        self.cfg = cfg
        self._client = None

    # -- lazy import so the rest of the project runs without the SDK installed --
    def client(self):
        if self._client is None:
            try:
                from snaptrade_client import SnapTrade
            except Exception as e:  # pragma: no cover
                raise RuntimeError(
                    "The SnapTrade SDK isn't installed. Run:  pip install snaptrade-python-sdk"
                ) from e
            missing = self.cfg.missing_snaptrade()
            if missing:
                raise RuntimeError("Missing env vars: " + ", ".join(missing))
            # SDK v12+ requires the keys inside a Configuration object — passed as
            # plain kwargs they are SILENTLY DROPPED, requests go out unsigned, and
            # SnapTrade answers 401/403 "credentials were not provided". Older SDKs
            # (v11) take the kwargs directly, so fall back for them.
            try:
                from snaptrade_client import Configuration
                _conf = Configuration(consumer_key=self.cfg.consumer_key,
                                      client_id=self.cfg.client_id)
                self._client = SnapTrade(configuration=_conf)
            except Exception:
                self._client = SnapTrade(
                    consumer_key=self.cfg.consumer_key,
                    client_id=self.cfg.client_id,
                )
        return self._client

    # ---- one-time setup helpers ----
    def register_user(self, user_id: str) -> dict:
        """Register the SnapTrade user (once). Returns {userId, userSecret} — SAVE the secret."""
        resp = self.client().authentication.register_snap_trade_user(user_id=user_id)
        return dict(_body(resp))

    def connect_url(self) -> str:
        """Connection Portal link — open it, log into Stake on SnapTrade's screen, approve."""
        resp = self.client().authentication.login_snap_trade_user(
            user_id=self.cfg.user_id, user_secret=self.cfg.user_secret,
            connection_type="trade",  # 21 Aug 2026: Phase 0 shipped read-only by design;
                                       # the exit phase needs trading. DRY_RUN/APPROVE
                                       # gates in the bridge remain the shield.
        )
        b = _body(resp)
        return b.get("redirectURI") or b.get("redirect_uri") or str(b)

    # ---- Phase 0: read-only ----
    def list_accounts(self) -> list[Account]:
        resp = self.client().account_information.list_user_accounts(
            user_id=self.cfg.user_id, user_secret=self.cfg.user_secret,
        )
        out = []
        for a in _body(resp) or []:
            out.append(Account(
                id=str(a.get("id", "")),
                name=str(a.get("name", "") or a.get("institution_name", "")),
                number=str(a.get("number", "")),
                institution=str(a.get("institution_name", "")),
            ))
        return out
    def _holdings_body(self, account_id: str) -> dict:
        # 21 Aug 2026: SnapTrade retired the combined /holdings endpoint (410
        # Gone). Positions and balances now come from two calls; we rebuild the
        # old combined shape here so get_holdings/get_cash need no changes.
        c = self.client()
        pos = c.account_information.get_user_account_positions(
            account_id=account_id, user_id=self.cfg.user_id, user_secret=self.cfg.user_secret,
        )
        bal = c.account_information.get_user_account_balance(
            account_id=account_id, user_id=self.cfg.user_id, user_secret=self.cfg.user_secret,
        )
        return {"positions": list(_body(pos) or []), "balances": list(_body(bal) or [])}
   
    def get_holdings(self, account_id: str) -> list[Holding]:
        b = self._holdings_body(account_id)
        out = []
        for p in (b.get("positions") or []):
            sym = p.get("symbol") or {}
            # symbol nesting varies: {symbol:{symbol:{raw_symbol|symbol}}}
            inner = sym.get("symbol") if isinstance(sym.get("symbol"), dict) else sym
            ticker = (inner.get("raw_symbol") or inner.get("symbol") or sym.get("raw_symbol") or "")
            out.append(Holding(
                ticker=str(ticker).upper(),
                qty=float(p.get("units") or p.get("fractional_units") or 0),
                price=(float(p["price"]) if p.get("price") not in (None, "") else None),
                currency=str((p.get("currency") or {}).get("code", "AUD")) if isinstance(p.get("currency"), dict) else "AUD",
            ))
        return out

    def get_cash(self, account_id: str) -> float:
        b = self._holdings_body(account_id)
        total = 0.0
        for bal in (b.get("balances") or []):
            try:
                total += float(bal.get("cash") or 0)
            except (TypeError, ValueError):
                pass
        return round(total, 2)

    # ---- Phase 2+: trading (defined now; only reached after the safety engine allows) ----
    # ---- exit engine surface (phase 2, 22 Aug 2026) --------------------------
    def get_open_orders(self, account_id: str) -> list[dict]:  # pragma: no cover - live
        resp = self.client().account_information.get_user_account_orders(
            account_id=account_id, user_id=self.cfg.user_id, user_secret=self.cfg.user_secret,
            state="open",
        )
        out = []
        for o in (_body(resp) or []):
            sym = o.get("symbol") or o.get("universal_symbol") or {}
            inner = sym.get("symbol") if isinstance(sym.get("symbol"), dict) else sym
            ticker = ""
            if isinstance(inner, dict):
                ticker = inner.get("raw_symbol") or inner.get("symbol") or ""
            if not ticker:
                ticker = o.get("symbol") if isinstance(o.get("symbol"), str) else ""
            out.append({
                "id": str(o.get("brokerage_order_id") or o.get("id") or ""),
                "ticker": str(ticker).upper(),
                "action": str(o.get("action") or "").upper(),
                "order_type": str(o.get("order_type") or o.get("type") or ""),
                "stop": o.get("stop_price"),
                "qty": o.get("total_quantity") or o.get("units"),
            })
        return out

    def place_stop_sell(self, account_id: str, ticker: str, qty: int, stop_price: float) -> dict:  # pragma: no cover - live
        """place_force_order: our own safety engine has already validated; the
        impact endpoint refuses outside market hours (learned on the weekend
        probe, 22 Aug), so the executor places directly. GTC = Stake's resting
        stop (lives up to 90 days)."""
        resp = self.client().trading.place_force_order(
            user_id=self.cfg.user_id, user_secret=self.cfg.user_secret,
            account_id=account_id,
            action="SELL", order_type="Stop", time_in_force="GTC",
            units=float(qty), stop=float(stop_price),
            symbol=str(ticker).upper(),
        )
        b = dict(_body(resp) or {})
        oid = str(b.get("brokerage_order_id") or (b.get("order") or {}).get("brokerage_order_id") or b.get("id") or "")
        return {"id": oid, "raw": b}

    def cancel_order(self, account_id: str, order_id: str) -> dict:  # pragma: no cover - live
        resp = self.client().trading.cancel_user_account_order(
            user_id=self.cfg.user_id, user_secret=self.cfg.user_secret,
            account_id=account_id, brokerage_order_id=str(order_id),
        )
        return dict(_body(resp) or {})

    def place_order(self, account_id: str, order) -> dict:  # pragma: no cover - Phase 2
        """Preview impact then place. NOT used in Phase 0. Wired for when you enable trading."""
        cli = self.client()
        action = "BUY" if order.action == "BUY" else "SELL"
        otype = "Limit" if order.order_type == "LIMIT" else "Market"
        impact = cli.trading.get_order_impact(
            account_id=account_id, user_id=self.cfg.user_id, user_secret=self.cfg.user_secret,
            action=action, order_type=otype, price=(order.limit or None),
            time_in_force="Day", units=order.qty, universal_symbol_id=None, symbol=order.ticker,
        )
        trade_id = dict(_body(impact)).get("trade", {}).get("id")
        placed = cli.trading.place_order(
            trade_id=trade_id, user_id=self.cfg.user_id, user_secret=self.cfg.user_secret,
        )
        return dict(_body(placed))

    # ---- watcher surface (Regime B, 23 Aug 2026) --------------------------
    def get_quotes(self, account_id: str, tickers: list[str]) -> dict:  # pragma: no cover - live
        """ONE batched request per cycle for every synthetic-regime ticker
        (SnapTrade per-account limit ~10/min; a 60s cycle uses 1)."""
        if not tickers:
            return {}
        resp = self.client().trading.get_user_account_quotes(
            user_id=self.cfg.user_id, user_secret=self.cfg.user_secret,
            account_id=account_id, symbols=",".join(sorted({t.upper() for t in tickers})),
            use_ticker=True,
        )
        out = {}
        for q in (_body(resp) or []):
            sym = q.get("symbol") or {}
            inner = sym.get("symbol") if isinstance(sym.get("symbol"), dict) else sym
            t = str(inner.get("raw_symbol") or inner.get("symbol") or sym.get("raw_symbol") or "").upper()
            if not t:
                continue
            def _f(v):
                try:
                    return float(v) if v not in (None, "") else None
                except (TypeError, ValueError):
                    return None
            out[t] = {"last": _f(q.get("last_trade_price")), "bid": _f(q.get("bid_price"))}
        return out

    def place_sell(self, account_id: str, ticker: str, qty: int, limit=None) -> dict:  # pragma: no cover - live
        """The watcher's fire: place_force_order like place_stop_sell (the
        impact endpoint refuses odd states; our safety engine already gated)."""
        kw = dict(user_id=self.cfg.user_id, user_secret=self.cfg.user_secret,
                  account_id=account_id, action="SELL", time_in_force="Day",
                  units=float(qty), symbol=str(ticker).upper())
        if limit is not None:
            kw.update(order_type="Limit", price=float(limit))
        else:
            kw.update(order_type="Market")
        resp = self.client().trading.place_force_order(**kw)
        b = dict(_body(resp) or {})
        oid = str(b.get("brokerage_order_id") or (b.get("order") or {}).get("brokerage_order_id") or b.get("id") or "")
        return {"id": oid, "raw": b}
