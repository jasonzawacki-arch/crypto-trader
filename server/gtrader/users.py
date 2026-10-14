"""Manage users from the command line (reads GT_DB, the same database the server uses).

    python -m gtrader.users add alice trader      # asks for the password
    python -m gtrader.users list
    python -m gtrader.users remove alice

Roles: viewer, trader, admin. Without GT_DB the users would vanish when this command exits, so it refuses.
"""
import getpass
import os
import sys

from .auth import Auth
from .store import Store


def main(argv: list[str]) -> int:
    db = os.environ.get("GT_DB")
    if not db:
        print("Set GT_DB to the server's database file first.", file=sys.stderr)
        return 2
    a = Auth(Store(db))
    if len(argv) >= 3 and argv[0] == "add":
        pw = os.environ.get("GT_NEW_PASSWORD") or getpass.getpass("Password (8+ characters): ")
        try:
            a.add_user(argv[1], pw, argv[2])
        except ValueError as e:
            print(e, file=sys.stderr)
            return 1
        print(f"Saved {argv[1]} as {argv[2]}.")
    elif argv[:1] == ["list"]:
        for u in a.store.users():
            print(f"{u['name']:<20}{u['role']}")
    elif len(argv) == 2 and argv[0] == "remove":
        try:
            a.remove_user(argv[1])
        except (KeyError, ValueError) as e:
            print(str(e).strip("'"), file=sys.stderr)
            return 1
        print("Removed.")
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
