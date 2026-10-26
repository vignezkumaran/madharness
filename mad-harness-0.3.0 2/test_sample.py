"""
Sample Python file for testing the MAD Harness AST Pruner.
This file simulates a real-world Python module with classes, functions,
decorators, type hints, and various patterns.
"""

import os
import sys
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass, field
from pathlib import Path

# ─── Constants ───────────────────────────────────────────────────────────────

MAX_RETRIES = 3
DEFAULT_TIMEOUT = 30.0
API_VERSION: str = "2.0.0"
SUPPORTED_FORMATS: List[str] = ["json", "yaml", "toml"]

# ─── Data Classes ────────────────────────────────────────────────────────────

@dataclass
class Config:
    """Application configuration."""
    host: str = "localhost"
    port: int = 8080
    debug: bool = False
    timeout: float = DEFAULT_TIMEOUT
    retries: int = MAX_RETRIES
    tags: List[str] = field(default_factory=list)

    def validate(self) -> bool:
        """Validate configuration values."""
        if self.port < 0 or self.port > 65535:
            raise ValueError(f"Invalid port: {self.port}")
        if self.timeout <= 0:
            raise ValueError(f"Timeout must be positive: {self.timeout}")
        if self.retries < 0:
            raise ValueError(f"Retries must be non-negative: {self.retries}")
        return True

    def to_dict(self) -> Dict[str, any]:
        """Convert config to dictionary."""
        return {
            "host": self.host,
            "port": self.port,
            "debug": self.debug,
            "timeout": self.timeout,
            "retries": self.retries,
            "tags": self.tags,
        }


@dataclass
class TaskResult:
    """Result from a task execution."""
    task_id: str
    status: str
    output: str
    duration: float
    error: Optional[str] = None
    metadata: Dict[str, str] = field(default_factory=dict)


# ─── Utility Functions ──────────────────────────────────────────────────────

def calculate_total(
    items: List[Dict[str, float]],
    tax_rate: float = 0.1,
    discount: Optional[float] = None
) -> float:
    """Calculate the total with tax and optional discount."""
    subtotal = sum(item.get('price', 0) for item in items)
    if discount is not None:
        subtotal -= subtotal * discount
    tax = subtotal * tax_rate
    return round(subtotal + tax, 2)


def validate_input(data: Dict[str, any], schema: Dict[str, type]) -> Tuple[bool, List[str]]:
    """Validate input data against a schema."""
    errors: List[str] = []
    for key, expected_type in schema.items():
        if key not in data:
            errors.append(f"Missing required field: {key}")
        elif not isinstance(data[key], expected_type):
            errors.append(f"Invalid type for {key}: expected {expected_type.__name__}")
    return len(errors) == 0, errors


def format_duration(seconds: float) -> str:
    """Format duration in human-readable format."""
    if seconds < 1:
        return f"{seconds * 1000:.0f}ms"
    elif seconds < 60:
        return f"{seconds:.1f}s"
    elif seconds < 3600:
        minutes = int(seconds // 60)
        secs = seconds % 60
        return f"{minutes}m {secs:.0f}s"
    else:
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        return f"{hours}h {minutes}m"


# ─── Core Classes ────────────────────────────────────────────────────────────

class OrderProcessor:
    """Processes orders through the pipeline."""

    def __init__(self, db_connection: any, config: Config):
        self.db = db_connection
        self.config = config
        self._cache: Dict[str, any] = {}
        self._retry_count = 0

    async def process(self, order_id: int) -> TaskResult:
        """Process a single order."""
        start_time = __import__('time').time()
        try:
            # Fetch from cache first
            if str(order_id) in self._cache:
                return self._cache[str(order_id)]

            # Query database
            result = await self._fetch_order(order_id)
            transformed = self._transform(result)
            validated = self._validate_order(transformed)

            if not validated:
                raise ValueError(f"Order {order_id} failed validation")

            # Store in cache
            self._cache[str(order_id)] = TaskResult(
                task_id=str(order_id),
                status="completed",
                output=str(transformed),
                duration=__import__('time').time() - start_time,
            )
            return self._cache[str(order_id)]
        except Exception as e:
            return TaskResult(
                task_id=str(order_id),
                status="failed",
                output="",
                duration=__import__('time').time() - start_time,
                error=str(e),
            )

    async def _fetch_order(self, order_id: int) -> Dict:
        """Fetch order from database."""
        for attempt in range(self.config.retries):
            try:
                return await self.db.query(
                    "SELECT * FROM orders WHERE id = ?",
                    [order_id]
                )
            except ConnectionError:
                if attempt == self.config.retries - 1:
                    raise
                await __import__('asyncio').sleep(1)
        return {}

    def _transform(self, data: Dict) -> Dict:
        """Transform raw data into processed format."""
        return {
            k: v.strip() if isinstance(v, str) else v
            for k, v in data.items()
            if v is not None
        }

    def _validate_order(self, order: Dict) -> bool:
        """Validate an order has all required fields."""
        required = ['id', 'customer_id', 'items', 'total']
        return all(field in order for field in required)

    @property
    def cache_size(self) -> int:
        """Get current cache size."""
        return len(self._cache)

    def clear_cache(self) -> None:
        """Clear the order cache."""
        self._cache.clear()
        self._retry_count = 0


class PaymentHandler:
    """Handles payment processing with retry logic."""

    SUPPORTED_METHODS = ['credit_card', 'debit_card', 'bank_transfer', 'crypto']

    def __init__(self, gateway_url: str, api_key: str):
        self.gateway_url = gateway_url
        self.api_key = api_key
        self._transactions: List[Dict] = []

    async def charge(
        self,
        amount: float,
        currency: str = "USD",
        method: str = "credit_card"
    ) -> Dict[str, any]:
        """Process a payment charge."""
        if method not in self.SUPPORTED_METHODS:
            raise ValueError(f"Unsupported payment method: {method}")

        if amount <= 0:
            raise ValueError(f"Amount must be positive: {amount}")

        # Simulate API call
        import uuid
        transaction_id = str(uuid.uuid4())
        result = {
            "transaction_id": transaction_id,
            "amount": amount,
            "currency": currency,
            "method": method,
            "status": "completed",
        }
        self._transactions.append(result)
        return result

    async def refund(self, transaction_id: str, amount: Optional[float] = None) -> Dict[str, any]:
        """Process a refund for a transaction."""
        transaction = next(
            (t for t in self._transactions if t["transaction_id"] == transaction_id),
            None
        )
        if not transaction:
            raise ValueError(f"Transaction not found: {transaction_id}")

        refund_amount = amount or transaction["amount"]
        if refund_amount > transaction["amount"]:
            raise ValueError("Refund amount exceeds transaction amount")

        return {
            "refund_id": f"ref_{transaction_id[:8]}",
            "original_transaction": transaction_id,
            "amount": refund_amount,
            "status": "refunded",
        }

    @staticmethod
    def format_amount(amount: float, currency: str = "USD") -> str:
        """Format an amount with currency symbol."""
        symbols = {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥"}
        symbol = symbols.get(currency, currency)
        return f"{symbol}{amount:,.2f}"

    def get_transaction_history(self) -> List[Dict]:
        """Get all transaction history."""
        return list(self._transactions)


# ─── Entry Point ─────────────────────────────────────────────────────────────

def main() -> None:
    """Main entry point for the application."""
    config = Config(host="0.0.0.0", port=8080, debug=True)
    config.validate()
    print(f"Server starting on {config.host}:{config.port}")
    print(f"Debug mode: {config.debug}")
    print(f"API version: {API_VERSION}")


if __name__ == "__main__":
    main()
