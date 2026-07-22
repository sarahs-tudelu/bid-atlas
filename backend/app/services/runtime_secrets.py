from __future__ import annotations

from functools import lru_cache


@lru_cache(maxsize=16)
def _parameter_value(name: str) -> str:
    import boto3

    response = boto3.client("ssm").get_parameter(Name=name, WithDecryption=True)
    value = str(response["Parameter"]["Value"]).strip()
    if not value:
        raise RuntimeError(f"AWS parameter {name!r} is empty")
    return value


def runtime_secret(value: str | None, parameter_name: str | None) -> str:
    if value and value.strip():
        return value.strip()
    if parameter_name and parameter_name.strip():
        return _parameter_value(parameter_name.strip())
    raise RuntimeError("Required authentication secret is not configured")
