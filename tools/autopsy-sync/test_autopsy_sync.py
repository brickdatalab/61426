import autopsy_sync as a


def test_slug_from_filename():
    assert a.slug_from_filename("btc-updown-5m-1783348800_v6.json") == "btc-updown-5m-1783348800"
    assert a.slug_from_filename("eth-updown-5m-1783038600_v53.json") == "eth-updown-5m-1783038600"
    assert a.slug_from_filename("test.json") is None
    assert a.slug_from_filename("cors-test.json") is None


def test_interval_and_bar_end():
    assert a.interval_seconds("btc-updown-5m-1783348800") == 300
    assert a.interval_seconds("btc-updown-15m-1783348800") == 900
    assert a.interval_seconds("btc-updown-1h-1783348800") == 3600
    assert a.bar_end_epoch("btc-updown-5m-1783348800") == 1783348800 + 300


def test_is_due():
    end = 1783348800 + 300
    assert a.is_due("btc-updown-5m-1783348800", end + 300) is True
    assert a.is_due("btc-updown-5m-1783348800", end + 299) is False


def test_settle_from_log():
    doc = {"rows": [{"t": "1", "signal": "UP"}, {"t": "2", "settled": "DOWN", "open": 1, "close": 0}]}
    assert a.settle_from_log(doc) == "DOWN"
    assert a.settle_from_log({"rows": [{"t": "1", "signal": "UP"}]}) is None


def test_resolution_from_gamma():
    up = [{"markets": [{"closed": True, "outcomes": '["Up","Down"]', "outcomePrices": '["1","0"]'}]}]
    dn = [{"markets": [{"closed": True, "outcomes": '["Up","Down"]', "outcomePrices": '["0","1"]'}]}]
    pend = [{"markets": [{"closed": False, "outcomes": '["Up","Down"]', "outcomePrices": '["0.96","0.04"]'}]}]
    assert a.resolution_from_gamma(up) == {"resolved": True, "direction": "UP"}
    assert a.resolution_from_gamma(dn) == {"resolved": True, "direction": "DOWN"}
    assert a.resolution_from_gamma(pend) == {"resolved": False, "direction": None}
    assert a.resolution_from_gamma([]) == {"resolved": False, "direction": None}


def test_decide():
    assert a.decide("DOWN", {"resolved": True, "direction": "UP"}) == ("correct", "UP")
    assert a.decide("UP", {"resolved": True, "direction": "UP"}) == ("keep", "UP")
    assert a.decide("UP", {"resolved": False, "direction": None}) == ("wait", None)
    assert a.decide("UP", {"resolved": True, "direction": None}) == ("ambiguous", None)
    assert a.decide(None, {"resolved": True, "direction": "UP"}) == ("nosettle", None)


def test_same_data_is_formatting_agnostic(tmp_path):
    doc = {"slug": "x", "rows": [{"t": "1", "settled": "UP", "open": 1, "close": 2}]}
    p = tmp_path / "f.json"
    p.write_text(a.json.dumps(doc, indent=2))          # different indentation/formatting
    assert a._same_data(p, doc) is True                 # equal data -> True
    p.write_text(a.json.dumps(doc, separators=(",", ":")))  # minified -> still equal data
    assert a._same_data(p, doc) is True
    other = {"slug": "x", "rows": [{"t": "1", "settled": "DOWN", "open": 1, "close": 2}]}
    assert a._same_data(p, other) is False              # different settle -> False
    assert a._same_data(tmp_path / "missing.json", doc) is False  # missing file -> False


def _write_log(log_dir, slug, body_rows, settle="UP"):
    rows = [{"t": str(i), "signal": "UP"} for i in range(body_rows)]
    rows.append({"t": "z", "settled": settle, "open": 1, "close": 2})
    (log_dir / f"{slug}_v6.json").write_text(a.json.dumps({"slug": f"{slug}_v6", "rows": rows}))


def test_process_skips_incomplete_below_min_rows(tmp_path, monkeypatch):
    log_dir = tmp_path / "logs"; log_dir.mkdir()
    repo = tmp_path / "repo"; (repo / "AUTOPSY" / "logs").mkdir(parents=True)
    slug = "btc-updown-5m-1783348800"  # well in the past -> is_due True
    _write_log(log_dir, slug, body_rows=5)  # incomplete
    # gamma must never be consulted for a skipped log
    monkeypatch.setattr(a, "fetch_gamma", lambda s: (_ for _ in ()).throw(AssertionError("gamma should not be called")))
    staged = a.process(str(log_dir), str(repo), dry_run=True, min_rows=50)
    assert staged == []


def test_process_syncs_complete_at_or_above_min_rows(tmp_path, monkeypatch):
    log_dir = tmp_path / "logs"; log_dir.mkdir()
    repo = tmp_path / "repo"; (repo / "AUTOPSY" / "logs").mkdir(parents=True)
    slug = "btc-updown-5m-1783348800"
    _write_log(log_dir, slug, body_rows=60, settle="UP")  # complete
    monkeypatch.setattr(a, "fetch_gamma", lambda s: [{"markets": [{"closed": True, "outcomes": '["Up","Down"]', "outcomePrices": '["1","0"]'}]}])
    monkeypatch.setattr(a.time, "sleep", lambda s: None)
    staged = a.process(str(log_dir), str(repo), dry_run=True, min_rows=50)
    assert f"{slug}_v6.json" in staged
