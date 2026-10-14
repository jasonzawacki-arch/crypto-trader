"""Venue selection. Only the paper venue is enabled.

A live adapter would subclass types.Exchange (rules, place_order, cancel_order, open_orders), read keys from the
server's environment, reconcile balances and open orders on start, and repeat the risk limits server-side.
Until that exists, asking for live trading fails loudly instead of quietly falling back.
"""
import os


def make_exchange_guard() -> None:
    if os.environ.get("GT_EXCHANGE", "paper").lower() != "paper":
        raise RuntimeError("Only the paper exchange is implemented. Unset GT_EXCHANGE to run paper trading.")
