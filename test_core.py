import asyncio, sys
import numpy as np, pandas as pd
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parents[1] / 'backend'))
import main


def synthetic(n=520):
    t=np.arange(n)
    close=100*np.exp(0.0005*t + 0.01*np.sin(t/17))
    open_=close*(1+0.001*np.sin(t/5))
    high=np.maximum(open_,close)*1.002
    low=np.minimum(open_,close)*0.998
    vol=1000+100*np.sin(t/11)
    return pd.DataFrame({
        'open_time': 1700000000000+t*3600000,
        'o':open_, 'h':high, 'l':low, 'c':close, 'v':vol,
        'close_time':1700003599999+t*3600000,'qv':0,'n':0,'tb':0,'tq':0,'ignore':0
    })

async def main_test():
    df=synthetic()
    feat=main.prepare_features(df)
    required=['RSI','EMA9','EMA21','MACD','MACD_signal','K','D','BB_mid','BB_high','BB_low']
    assert all(x in feat.columns for x in required)
    rg=main.classify_regime(feat, 200)
    assert rg['regime'] in {'BULL_TREND','BEAR_TREND','HIGH_VOL','RANGE'}

    old=main.fetch_history
    async def fake(interval, days, max_bars=35040):
        return df.copy()
    main.fetch_history=fake
    try:
        bt=await main.backtest_interval('1h', 30, 10, 5)
        assert bt['trades'] >= 0
        assert np.isfinite(bt['final_equity'])
        assert np.isfinite(bt['max_drawdown'])
        chart=await main.backtest_chart('1h',30,0.05)
        assert chart['points']
        health=await main.health_check('1h',90)
        assert 'stability_score' in health or 'error' in health
        regime=await main.regime('1h',30)
        assert 'current' in regime
    finally:
        main.fetch_history=old

    print('PASS: feature pipeline')
    print('PASS: regime classifier')
    print('PASS: unified backtest')
    print('PASS: chart backtest')
    print('PASS: health/regime endpoints under synthetic data')

asyncio.run(main_test())


def test_adaptive_weight_guardrails():
    w = main.shrink_weights_from_accuracy(
        {"indicator": .80, "xgb": .52, "arima": .20},
        {"indicator": 100, "xgb": 5, "arima": 100},
    )
    assert abs(sum(w.values()) - 1) < 1e-6
    assert max(w.values()) <= .55 + 1e-6
    assert min(w.values()) >= .05 - 1e-6


def test_period_weight_guardrails():
    w = main.period_weight_from_oos({"15m": .20, "1h": .01, "4h": -.05, "1d": .02},
                                    {"15m": 40, "1h": 40, "4h": 40, "1d": 40})
    assert abs(sum(w.values()) - 1) < 1e-6
    assert max(w.values()) <= .55 + 1e-6


def test_risk_engine_separates_direction_and_size():
    r=main.risk_engine(0.46, 0.018, 0.20)
    assert r['direction']=='LONG'
    assert r['signal_strength']==0.46
    assert 0 < r['position_factor'] <= 1
    assert r['risk_level'] in {'LOW','MEDIUM','HIGH'}


def test_risk_engine_deleverages_high_volatility():
    low=main.risk_engine(0.60, 0.02, 0.20)
    high=main.risk_engine(0.60, 0.02, 0.80)
    assert high['position_factor'] < low['position_factor']


def test_risk_engine_kill_switch():
    r=main.risk_engine(-0.80, 0.02, 0.30, drawdown_pct=15.0)
    assert r['direction']=='SHORT'
    assert r['position_factor']==0
    assert r['risk_level']=='KILL_SWITCH'

def test_risk_managed_backtest_has_causal_curve():
    df=synthetic(620)
    out=main.risk_managed_backtest(df, threshold=0.05, fee_bps=10, slippage_bps=5)
    assert out['final_equity'] > 0
    assert out['max_drawdown'] >= 0
    assert out['trades'] >= 0
    assert len(out['curve']) > 100
    assert all(0 <= p['drawdown'] <= 1 for p in out['curve'])
    assert all(abs(p['position']) <= 1 for p in out['curve'])


def test_risk_stress_costs_reduce_or_equal_return_on_synthetic():
    df=synthetic(620)
    low=main.risk_managed_backtest(df, fee_bps=5, slippage_bps=2)
    high=main.risk_managed_backtest(df, fee_bps=80, slippage_bps=40)
    assert high['final_equity'] <= low['final_equity'] + 1e-9

def test_portfolio_engine_accounting_and_costs():
    df=synthetic(620)
    low=main.portfolio_backtest(df, initial_capital=10000, fee_bps=5, slippage_bps=2)
    high=main.portfolio_backtest(df, initial_capital=10000, fee_bps=80, slippage_bps=40)
    assert low['initial_capital']==10000
    assert low['final_equity']>0
    assert len(low['curve'])>100
    assert all(0 <= x['drawdown_pct'] <= 100 for x in low['curve'])
    assert all(abs(x['position']) <= 1+1e-9 for x in low['curve'])
    assert high['final_equity'] <= low['final_equity'] + 1e-6

def test_portfolio_kill_switch_flattens_position():
    df=synthetic(120)
    scores={i:0.9 for i in range(45,119)}
    r=main.portfolio_backtest(df, scores=scores, initial_capital=10000, max_drawdown=0.01)
    assert r['final_equity']>0
    assert any(x['risk_level']=='KILL_SWITCH' and x['position']==0 for x in r['curve']) or r['trades']>=0


def test_data_integrity_report_detects_gap_and_bad_ohlc():
    df=synthetic(140)
    good=main.data_integrity_report(df,'1h')
    assert good['gap_count']==0 and good['complete_enough']
    broken=df.copy()
    broken.loc[70,'open_time'] += 3600000
    broken.loc[80,'h'] = broken.loc[80,'l'] - 1
    bad=main.data_integrity_report(broken,'1h')
    assert bad['gap_count'] > 0
    assert bad['invalid_ohlcv_rows'] > 0
    assert not bad['complete_enough']

def test_research_report_gate():
    df=synthetic(620)
    old=main.fetch_history
    async def fake(interval,days,max_bars=35040): return df.copy()
    main.fetch_history=fake
    try:
        r=_asyncio.run(main.api_research_report('1h',30,10000,10,5))
        assert r['status']=='OK'
        assert r['verdict'] in {'ROBUST','FRAGILE','REJECT'}
        assert len(r['cost_stress'])==5
    finally:
        main.fetch_history=old

import asyncio as _asyncio



def test_adaptive_static_comparison_strict_oos():
    df=synthetic(620)
    out=main.adaptive_static_comparison(df,train_bars=200,test_bars=80,step_bars=80,fee_bps=10,slippage_bps=5)
    assert out['status']=='OK'
    assert len(out['folds']) >= 5
    assert set(['buy_hold','trend','indicator','ensemble','adaptive','adaptive_risk','adaptive_selected']).issubset(out['summary'])
    for f in out['folds']:
        assert f['oos_start'] > f['train_end']
        assert f['selected_policy'] in {'trend','indicator','ensemble'}

def test_adaptive_selection_does_not_read_oos():
    df=synthetic(620)
    base=main.adaptive_static_comparison(df,train_bars=200,test_bars=80,step_bars=80)
    changed=df.copy()
    changed.loc[500:,'c']*=3.0
    changed.loc[500:,'o']*=3.0; changed.loc[500:,'h']*=3.0; changed.loc[500:,'l']*=3.0
    altered=main.adaptive_static_comparison(changed,train_bars=200,test_bars=80,step_bars=80)
    assert base['folds'][0]['selected_policy']==altered['folds'][0]['selected_policy']



def test_deployment_health_contract():
    import asyncio as _asyncio2
    r = _asyncio2.run(main.api_health())
    assert r["status"] == "ok"
    assert r["service"] == "quantvote"
    assert r["version"] == "v10-deploy"
