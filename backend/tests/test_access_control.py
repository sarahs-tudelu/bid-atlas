from fastapi.testclient import TestClient

from backend.app.main import create_app


def test_application_data_requires_a_tudelu_session() -> None:
    client = TestClient(create_app())

    for path in ("/api/meta", "/api/integrations", "/api/inbox"):
        response = client.get(path)
        assert response.status_code == 401
        assert "Tudelu" in response.json()["detail"]

    assert client.get("/api/auth/google/status").status_code == 200
    assert client.get("/health").status_code == 200
