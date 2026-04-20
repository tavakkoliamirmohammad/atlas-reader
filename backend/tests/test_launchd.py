import sys
from app import launchd


def test_plist_path_points_at_launch_agents_dir():
    assert str(launchd.plist_path()).endswith("Library/LaunchAgents/com.amir.atlas.plist")


def test_render_plist_embeds_current_python_and_module():
    content = launchd.render_plist()
    assert "<key>Label</key>" in content
    assert "<string>com.amir.atlas</string>" in content
    assert sys.executable in content
    assert "-m" in content
    assert "app.cli" in content
    assert "<key>RunAtLoad</key>" in content
    assert "<true/>" in content
    assert "<key>KeepAlive</key>" in content


def test_install_writes_plist(tmp_path, monkeypatch):
    target = tmp_path / "com.amir.atlas.plist"
    monkeypatch.setattr(launchd, "plist_path", lambda: target)
    monkeypatch.setattr(launchd, "_bootstrap", lambda: None)
    out = launchd.install()
    assert target.exists()
    assert "com.amir.atlas" in target.read_text()
    assert "installed" in out


def test_uninstall_removes_plist(tmp_path, monkeypatch):
    target = tmp_path / "com.amir.atlas.plist"
    target.write_text("placeholder")
    monkeypatch.setattr(launchd, "plist_path", lambda: target)
    monkeypatch.setattr(launchd, "_bootout", lambda: None)
    out = launchd.uninstall()
    assert not target.exists()
    assert "removed" in out


def test_uninstall_is_no_op_when_plist_absent(tmp_path, monkeypatch):
    target = tmp_path / "com.amir.atlas.plist"
    monkeypatch.setattr(launchd, "plist_path", lambda: target)
    monkeypatch.setattr(launchd, "_bootout", lambda: None)
    out = launchd.uninstall()
    assert "not installed" in out
