
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import asyncio, math, statistics, time, os
import httpx
import pandas as pd
import numpy as np

app = FastAPI(title="QuantVote Adaptive MVP")
_allowed_origins = [x.strip() for x in os.getenv("QV_ALLOWED_ORIGINS", "*").split(",") if x.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_allowed_origins, allow_methods=["GET"], allow_headers=["*"])

BASE = "https://data-api.binance.vision"
SYMBOL = "BTCUSDT"
INTERVALS = {"15m":"15m", "1H":"1h", "4H":"4h", "1D":"1d"}
state = {"price": None, "frames": {}, "updated": None, "error": None}

@app.get("/api/health")
async def api_health():
    return {"status": "ok", "service": "quantvote", "version": "v10-deploy-r3", "data_source": "binance-public-api"}

@app.get("/api/deployment")
async def deployment_info():
    return {
        "service": "quantvote",
        "public_url": os.getenv("RENDER_EXTERNAL_URL"),
        "platform": "render" if os.getenv("RENDER_EXTERNAL_URL") else "local",
        "port": int(os.getenv("PORT", "8000")),
        "ready": True,
    }

def ema(s, span): return s.ewm(span=span, adjust=False).mean()
def rsi(s, n=14):
    d=s.diff()
    up=d.clip(lower=0).ewm(alpha=1/n, adjust=False).mean()
    dn=(-d.clip(upper=0)).ewm(alpha=1/n, adjust=False).mean()
    rs=up/dn.replace(0, np.nan)
    out=100-(100/(1+rs))
    return out.fillna(50)
def indicators(df):
    c=df.c
    e9,e21=ema(c,9),ema(c,21)
    macd=ema(c,12)-ema(c,26); sig=ema(macd,9)
    rr=rsi(c)
    lo=df.l.rolling(14).min(); hi=df.h.rolling(14).max()
    rsv=(c-lo)/(hi-lo).replace(0,np.nan)*100
    k=rsv.ewm(com=2, adjust=False).mean().fillna(50)
    d=k.ewm(com=2, adjust=False).mean().fillna(50)
    mid=c.rolling(20).mean(); sd=c.rolling(20).std()
    upper,lower=mid+2*sd,mid-2*sd
    return rr,e9,e21,macd,sig,k,d,mid,upper,lower

def vote_components(df):
    rr,e9,e21,m,s,k,d,mid,up,lo=indicators(df)
    vals = {
        "RSI": 1 if rr.iloc[-1] < 70 and rr.iloc[-1] > 50 else (-1 if rr.iloc[-1] > 30 and rr.iloc[-1] < 50 else 0),
        "MACD": 1 if m.iloc[-1] > s.iloc[-1] else -1,
        "EMA": 1 if e9.iloc[-1] > e21.iloc[-1] else -1,
        "KDJ": 1 if k.iloc[-1] > d.iloc[-1] else -1,
        "BOLL": 1 if c_last(df) > mid.iloc[-1] else -1,
    }
    return vals

def c_last(df): return float(df.c.iloc[-1])

def score_from_votes(v, w):
    return sum(v[k]*w.get(k,0) for k in v) / max(sum(w.values()),1e-9)

DEFAULT_W={"RSI":.20,"MACD":.25,"EMA":.20,"KDJ":.15,"BOLL":.20}

BARS_PER_YEAR={"15m":35040,"1h":8760,"4h":2190,"1d":365}

# ---------------- Risk engine ----------------
def risk_engine(score, atr_pct, vol_ann, drawdown_pct=0.0, daily_loss_pct=0.0,
                regime="NORMAL", baseline=1.0, max_position=1.0,
                max_drawdown=15.0, max_daily_loss=3.0):
    """Separate directional signal from position sizing.

    `score` is directional strength in [-1, 1], not a probability.
    Risk is reduced by volatility, drawdown, daily loss and adverse regimes.
    The returned position_factor is a multiplier of baseline exposure.
    """
    score=float(max(-1.0,min(1.0,score)))
    atr_pct=max(0.0,float(atr_pct))
    vol_ann=max(0.0,float(vol_ann))
    dd=max(0.0,float(drawdown_pct))
    day=max(0.0,float(daily_loss_pct))

    direction="LONG" if score >= 0.08 else ("SHORT" if score <= -0.08 else "NEUTRAL")
    strength=abs(score)

    # Volatility scaling: 20% annualized is neutral; above 60% is heavily de-levered.
    vol_factor=1.0 if vol_ann <= 0.20 else max(0.25, 0.20/vol_ann)
    # ATR guard: 2% daily ATR is neutral; above 6% receives the floor.
    atr_factor=1.0 if atr_pct <= 0.02 else max(0.35, 0.02/atr_pct)
    dd_factor=0.0 if dd >= max_drawdown else max(0.0, 1.0-dd/max_drawdown)
    day_factor=0.0 if day >= max_daily_loss else max(0.0, 1.0-day/max_daily_loss)
    regime_factor={"HIGH_VOL":0.50,"BULL_TREND":1.0,"BEAR_TREND":1.0,
                   "RANGE":0.75,"NORMAL":1.0}.get(str(regime),0.75)

    raw=baseline*strength*vol_factor*atr_factor*dd_factor*day_factor*regime_factor
    position_factor=round(min(float(max_position),max(0.0,raw)),4)
    risk_level=("KILL_SWITCH" if position_factor==0 and (dd>=max_drawdown or day>=max_daily_loss)
                else "HIGH" if position_factor < 0.25
                else "MEDIUM" if position_factor < 0.55 else "LOW")
    return {
        "direction": direction,
        "signal_strength": round(strength,4),
        "risk_level": risk_level,
        "position_factor": position_factor,
        "volatility_factor": round(vol_factor,4),
        "atr_factor": round(atr_factor,4),
        "drawdown_factor": round(dd_factor,4),
        "daily_loss_factor": round(day_factor,4),
        "regime_factor": round(regime_factor,4),
        "limits": {"max_position": float(max_position), "max_drawdown_pct": float(max_drawdown),
                   "max_daily_loss_pct": float(max_daily_loss)},
        "note": "方向与仓位分离；position_factor 不是收益概率。"
    }

@app.get("/api/risk_engine")
async def api_risk_engine(score: float=0.0, atr_pct: float=0.02, vol_ann: float=0.20,
                          drawdown_pct: float=0.0, daily_loss_pct: float=0.0,
                          regime: str="NORMAL", baseline: float=1.0):
    return risk_engine(score, atr_pct, vol_ann, drawdown_pct, daily_loss_pct, regime, baseline)

def transition_cost(old_pos, new_pos, unit_cost):
    """Transaction cost in units of equity: entry/exit each cost unit; reversal costs two units."""
    if old_pos == new_pos:
        return 0.0
    legs = int(old_pos != 0) + int(new_pos != 0)
    return legs * unit_cost

def adaptive_weights(df):
    """Compute expanding hit-rate weights in O(n), without repeatedly slicing/recomputing indicators."""
    if len(df) < 42:
        return DEFAULT_W.copy()
    rr,e9,e21,m,s,k,d,mid,up,lo=indicators(df)
    future=np.sign(df.c.shift(-1)-df.c).to_numpy(dtype=float)
    signals={
        "RSI": np.where((rr>50)&(rr<70),1,np.where((rr>30)&(rr<50),-1,0)),
        "MACD": np.where(m>s,1,-1),
        "EMA": np.where(e9>e21,1,-1),
        "KDJ": np.where(k>d,1,-1),
        "BOLL": np.where(df.c>mid,1,-1),
    }
    out={}
    for name,sig in signals.items():
        valid=(np.arange(len(df))>=40)&(np.arange(len(df))<len(df)-1)&(sig!=0)&(future!=0)
        total=int(valid.sum())
        hits=int((sig[valid]==future[valid]).sum()) if total else 0
        acc=hits/total if total else .5
        out[name]=max(0.05,min(0.50,acc))
    total=sum(out.values())
    return {k:round(v/total,4) for k,v in out.items()}

def load_frame(raw):
    cols=["open_time","o","h","l","c","v","close_time","qv","n","tb","tq","ignore"]
    df=pd.DataFrame(raw, columns=cols)
    for x in ["o","h","l","c","v"]: df[x]=pd.to_numeric(df[x])
    df["open_time"]=pd.to_numeric(df["open_time"], errors="coerce").astype("int64")
    return df.sort_values("open_time").drop_duplicates("open_time").reset_index(drop=True)

def prepare_features(df):
    """Single feature/indicator pipeline used by all research modules."""
    out=df.copy()
    rr,e9,e21,macd,sig,k,d,mid,up,lo=indicators(out)
    out["RSI"]=rr
    out["EMA9"]=e9
    out["EMA21"]=e21
    out["MACD"]=macd
    out["MACD_signal"]=sig
    out["K"]=k
    out["D"]=d
    out["BB_mid"]=mid
    out["BB_high"]=up
    out["BB_low"]=lo
    return out

# Short live cache: the dashboard should not redownload years of candles every 15s.
_history_cache={}

async def fetch(interval, limit=500):
    url=f"{BASE}/api/v3/klines"
    async with httpx.AsyncClient(timeout=15) as client:
        r=await client.get(url, params={"symbol":SYMBOL,"interval":interval,"limit":min(int(limit),1000)})
        r.raise_for_status()
        return load_frame(r.json())

async def fetch_history(interval, days, max_bars=35040):
    """Paginated historical loader for research/backtests, with a small TTL cache."""
    import time as _time
    key=(interval,int(days))
    cached=_history_cache.get(key)
    if cached and _time.time()-cached["ts"] < 120:
        return cached["df"].copy()
    bars_per_day={"15m":96,"1h":24,"4h":6,"1d":1}[interval]
    target=min(int(days*bars_per_day)+120, max_bars)
    url=f"{BASE}/api/v3/klines"
    rows=[]
    end_time=None
    async with httpx.AsyncClient(timeout=20) as client:
        while len(rows)<target:
            params={"symbol":SYMBOL,"interval":interval,"limit":1000}
            if end_time is not None:
                params["endTime"]=end_time
            r=await client.get(url, params=params)
            r.raise_for_status()
            batch=r.json()
            if not batch:
                break
            rows=batch+rows
            oldest=int(batch[0][0])
            if len(batch)<1000:
                break
            end_time=oldest-1
    df=load_frame(rows).tail(target).reset_index(drop=True)
    _history_cache[key]={"ts":_time.time(),"df":df.copy()}
    return df

async def research_frame(interval, days):
    """Load enough historical data for research and attach the canonical feature set."""
    df = await fetch_history(interval, days)
    return prepare_features(df)

async def refresh():
    while True:
        try:
            frames={}
            for label, interval in INTERVALS.items():
                df=await fetch(interval)
                w=adaptive_weights(df)
                votes=vote_components(df)
                score=score_from_votes(votes,w)
                frames[label]={
                    "price":round(c_last(df),2),
                    "votes":votes,
                    "weights":w,
                    "score":round(50+50*score,1),
                    "candles":df[["o","h","l","c","v"]].tail(100).round(4).to_dict("records"),
                }
            state["frames"]=frames
            state["price"]=frames["15m"]["price"]
            state["updated"]=time.time()
            state["error"]=None
        except Exception as e:
            state["error"]=str(e)
        await asyncio.sleep(15)

@app.on_event("startup")
async def startup():
    asyncio.create_task(refresh())

@app.get("/api/market")
async def market():
    return state



# ---------------- ML models ----------------
def ml_features(df):
    x=pd.DataFrame(index=df.index)
    c=df.c
    x["ret1"]=c.pct_change()
    x["ret3"]=c.pct_change(3)
    x["ret6"]=c.pct_change(6)
    x["vol20"]=x["ret1"].rolling(20).std()
    x["rsi"]=rsi(c)
    x["ema_gap"]=ema(c,9)/ema(c,21)-1
    mac=ema(c,12)-ema(c,26)
    x["macd_gap"]=mac-ema(mac,9)
    x["volume_z"]=(df.v-df.v.rolling(20).mean())/df.v.rolling(20).std()
    return x.replace([np.inf,-np.inf],np.nan)

def backtest_positions(df, signals, start=45, fee_bps=10, slippage_bps=5, periods_year=8760):
    """Single execution/cost engine for all model comparisons.

    `signals[i]` is the position decided at close i and therefore applies to
    the i -> i+1 bar. Costs are charged only when exposure changes.
    """
    unit_cost=(fee_bps+slippage_bps)/10000.0
    equity=1.0; peak=1.0; mdd=0.0; pos=0; entry=None
    trades=0; wins=0; returns=[]
    for i in range(start, len(df)-1):
        new=int(signals.get(i, 0))
        p0=float(df.c.iloc[i]); p1=float(df.c.iloc[i+1])
        changed=new!=pos
        if changed and pos!=0 and entry is not None:
            gross=pos*(p0/entry-1.0)
            net=gross-transition_cost(pos,new,unit_cost)
            trades += 1; wins += int(net>0)
            entry=None
        cost=transition_cost(pos,new,unit_cost) if changed else 0.0
        bar_ret=pos*(p1/p0-1.0)
        net_bar=bar_ret-cost
        equity*=max(0.0,1.0+net_bar)
        returns.append(net_bar)
        if changed and new!=0:
            entry=p0
        pos=new
        peak=max(peak,equity); mdd=max(mdd,1-equity/peak)
    if pos!=0 and entry is not None:
        p=float(df.c.iloc[-1])
        gross=pos*(p/entry-1.0)
        net=gross-transition_cost(pos,0,unit_cost)
        trades += 1; wins += int(net>0)
        equity*=max(0.0,1.0-transition_cost(pos,0,unit_cost))
        peak=max(peak,equity); mdd=max(mdd,1-equity/peak)
    arr=np.asarray(returns,dtype=float)
    vol=float(arr.std(ddof=1)) if len(arr)>1 else 0.0
    sharpe=float(arr.mean()/vol*np.sqrt(periods_year)) if vol>1e-12 else 0.0
    return {"total_return":round((equity-1)*100,2),
            "max_drawdown":round(mdd*100,2),"sharpe":round(sharpe,2),
            "win_rate":round(100*wins/max(trades,1),2),"trades":trades,
            "final_equity":round(equity,4)}

def xgb_walkforward(df, min_train=120, fee_bps=10, slippage_bps=5, periods_year=8760):
    try:
        from xgboost import XGBClassifier
    except Exception:
        return None, "xgboost 未安装，请执行 pip install xgboost"
    X=ml_features(df)
    y=(df.c.shift(-1)>df.c).astype(int)
    signals={}
    for i in range(min_train, len(df)-1):
        train=pd.concat([X.iloc[:i],y.iloc[:i]],axis=1).dropna()
        if len(train)<80: continue
        model=XGBClassifier(n_estimators=120,max_depth=3,learning_rate=.05,
                            subsample=.85,colsample_bytree=.85,
                            objective="binary:logistic",eval_metric="logloss",
                            random_state=42,n_jobs=1)
        model.fit(train[X.columns],train[0])
        row=X.iloc[[i]]
        if row.isna().any(axis=None): continue
        prob=float(model.predict_proba(row[X.columns])[0,1])
        signals[i]=1 if prob>.55 else (-1 if prob<.45 else 0)
    out=backtest_positions(df,signals,start=min_train,fee_bps=fee_bps,slippage_bps=slippage_bps,periods_year=periods_year)
    return {"strategy":"XGBoost",**out},None


def arima_forecast_walkforward(df, min_train=80, fee_bps=10, slippage_bps=5, periods_year=8760):
    try:
        from statsmodels.tsa.arima.model import ARIMA
    except Exception:
        return None, "statsmodels 未安装，请执行 pip install statsmodels"
    lr=np.log(df.c).diff().replace([np.inf,-np.inf],np.nan).dropna()
    signals={}
    for j in range(min_train, len(lr)-1):
        train=lr.iloc[:j]
        try:
            fit=ARIMA(train,order=(1,0,1),trend="c").fit()
            pred=float(fit.forecast(1).iloc[0])
        except Exception:
            continue
        price_idx=lr.index[j]
        signals[int(price_idx)]=1 if pred>0 else -1
    out=backtest_positions(df,signals,start=min_train,fee_bps=fee_bps,slippage_bps=slippage_bps,periods_year=periods_year)
    return {"strategy":"ARIMA",**out},None


@app.get("/api/backtest_chart")
async def backtest_chart(interval: str="1h", days: int=90, threshold: float=0.05):
    """Return chart-ready walk-forward series with correctly applied costs."""
    if interval not in INTERVALS:
        interval = "1h"
    days = max(30, min(int(days), 180))
    threshold = float(threshold)

    df = await fetch_history(interval, days)
    if len(df) < 80:
        return {"points": [], "trades": [], "stats": {}}

    # Restrict the displayed/backtested sample to the requested horizon.
    bars_per_day = {"15m": 96, "1h": 24, "4h": 6, "1d": 1}[interval]
    n = min(len(df), days * bars_per_day)
    df = df.tail(n).reset_index(drop=True)

    equity = 1.0
    bh = 1.0
    pos = 0
    peak = 1.0
    max_dd = 0.0
    points = []
    trades = []
    fee = 0.0004
    slip = 0.0002

    start_i = 45
    for i in range(start_i, len(df) - 1):
        sig = indicator_signal_row(df, i)
        new_pos = 1 if sig > threshold else (-1 if sig < -threshold else 0)
        p0 = float(df.c.iloc[i])
        p1 = float(df.c.iloc[i + 1])

        changed = new_pos != pos
        cost = transition_cost(pos, new_pos, fee + slip)

        if changed:
            side = "BUY" if new_pos == 1 else ("SELL" if new_pos == -1 else "EXIT")
            trades.append({
                "index": i,
                "time": int(df.open_time.iloc[i]),
                "price": p0,
                "side": side,
                "position": new_pos
            })

        # Apply the position held during the next bar, then transaction costs.
        bar_ret = pos * (p1 / p0 - 1.0)
        equity *= max(0.0, 1.0 + bar_ret - cost)
        bh *= p1 / p0
        pos = new_pos

        peak = max(peak, equity)
        dd = max(0.0, 1.0 - equity / peak)
        max_dd = max(max_dd, dd)

        points.append({
            "time": int(df.open_time.iloc[i + 1]),
            "price": p1,
            "equity": equity,
            "buy_hold": bh,
            "drawdown": dd,
            "position": pos
        })

    if not points:
        return {"points": [], "trades": [], "stats": {}}

    final_eq = points[-1]["equity"]
    total_return = final_eq - 1.0
    bh_return = points[-1]["buy_hold"] - 1.0

    # Per-bar Sharpe, annualized according to the selected interval.
    eq_vals = [p["equity"] for p in points]
    rets = []
    for a, b in zip(eq_vals[:-1], eq_vals[1:]):
        if a > 0:
            rets.append(b / a - 1.0)
    import numpy as np
    sharpe = 0.0
    if len(rets) > 1 and np.std(rets, ddof=1) > 0:
        periods_year = {"15m": 35040, "1h": 8760, "4h": 2190, "1d": 365}[interval]
        sharpe = float(np.mean(rets) / np.std(rets, ddof=1) * np.sqrt(periods_year))

    wins = 0
    losses = 0
    for a, b in zip(trades[:-1], trades[1:]):
        if a["position"] == 1 and b["position"] <= 0:
            if b["price"] > a["price"]:
                wins += 1
            else:
                losses += 1
        elif a["position"] == -1 and b["position"] >= 0:
            if b["price"] < a["price"]:
                wins += 1
            else:
                losses += 1

    return {
        "interval": interval,
        "days": days,
        "threshold": threshold,
        "points": points,
        "trades": trades,
        "stats": {
            "return": total_return,
            "buy_hold": bh_return,
            "max_drawdown": max_dd,
            "sharpe": sharpe,
            "trades": len(trades),
            "win_rate": wins / (wins + losses) if wins + losses else 0.0
        }
    }


@app.get("/api/trade_audit")
async def trade_audit(interval: str="1h", days: int=90, threshold: float=0.05):
    """Return every signal change with indicator-level evidence."""
    if interval not in INTERVALS:
        interval = "1h"
    days = max(30, min(int(days), 180))
    df = await research_frame(interval, days)
    bars_per_day = {"15m": 96, "1h": 24, "4h": 6, "1d": 1}[interval]
    n = min(len(df), days * bars_per_day)
    df = df.tail(n).reset_index(drop=True)

    audits = []
    pos = 0
    fee, slip = 0.0004, 0.0002

    for i in range(45, len(df) - 1):
        row = df.iloc[i]
        sig = indicator_signal_row(df, i)
        new_pos = 1 if sig > threshold else (-1 if sig < -threshold else 0)
        if new_pos == pos:
            continue

        close = float(row.c)
        rsi = float(row.RSI)
        ema_gap = float((row.EMA9 - row.EMA21) / row.c)
        macd_gap = float(row.MACD - row.MACD_signal)
        k = float(row.K)
        d = float(row.D)
        bbp = float((row.c - row.BB_low) / max(row.BB_high-row.BB_low, 1e-12))

        # Component votes are deliberately exposed, not hidden inside the aggregate.
        votes = {
            "RSI": 1 if rsi < 30 else (-1 if rsi > 70 else 0),
            "EMA": 1 if row.EMA9 > row.EMA21 else -1,
            "MACD": 1 if row.MACD > row.MACD_signal else -1,
            "KDJ": 1 if k > d else -1,
            "Bollinger": 1 if bbp < 0.2 else (-1 if bbp > 0.8 else 0)
        }

        # Historical adaptive weights at this point.
        hist = df.iloc[max(0, i-120):i]
        weights = adaptive_weights(hist) if len(hist) >= 30 else {
            "RSI": .2, "EMA": .2, "MACD": .2, "KDJ": .2, "Bollinger": .2
        }

        weighted = sum(votes[k] * weights.get(k, 0.2) for k in votes)
        next_close = float(df.iloc[i+1].c)
        next_ret = next_close / close - 1.0

        audits.append({
            "index": i,
            "time": int(row.open_time),
            "price": close,
            "action": "BUY" if new_pos == 1 else ("SELL/SHORT" if new_pos == -1 else "EXIT"),
            "position_before": pos,
            "position_after": new_pos,
            "score": float(sig),
            "weighted_score": float(weighted),
            "next_bar_return": next_ret,
            "cost": fee + slip,
            "indicators": {
                "RSI": rsi,
                "EMA_gap_pct": ema_gap * 100,
                "MACD_gap": macd_gap,
                "K": k,
                "D": d,
                "BB_position": bbp
            },
            "votes": votes,
            "weights": weights
        })
        pos = new_pos

    return {
        "interval": interval,
        "days": days,
        "threshold": threshold,
        "trades": audits
    }


@app.get("/api/ensemble_audit")
async def ensemble_audit(interval: str="1h", days: int=90, threshold: float=0.05):
    """Unified historical audit: indicators + XGBoost + ARIMA + ensemble."""
    if interval not in INTERVALS:
        interval = "1h"
    days = max(30, min(int(days), 180))
    df = await research_frame(interval, days)
    bars_per_day = {"15m": 96, "1h": 24, "4h": 6, "1d": 1}[interval]
    n = min(len(df), days * bars_per_day)
    df = df.tail(n).reset_index(drop=True)

    if len(df) < 100:
        return {"trades": []}

    # Lazy imports keep the basic app usable if ML dependencies are unavailable.
    try:
        from xgboost import XGBClassifier
        xgb_ok = True
    except Exception:
        xgb_ok = False

    try:
        from statsmodels.tsa.arima.model import ARIMA
        arima_ok = True
    except Exception:
        arima_ok = False

    feature_cols = ["ret1","ret3","ret6","vol20","RSI","ema_gap","macd_gap","vol_z"]
    work = df.copy()
    work["ret1"] = work.c.pct_change()
    work["ret3"] = work.c.pct_change(3)
    work["ret6"] = work.c.pct_change(6)
    work["vol20"] = work["ret1"].rolling(20).std()
    work["ema_gap"] = (work.EMA9-work.EMA21)/work.c
    work["macd_gap"] = work.MACD-work.MACD_signal
    work["vol_z"] = (work.v-work.v.rolling(20).mean())/work.v.rolling(20).std()
    work["target"] = (work.c.shift(-1) > work.c).astype(int)

    audits = []
    last_xgb = None
    last_arima = None
    pos = 0

    for i in range(60, len(work)-1):
        row = work.iloc[i]

        # Indicator ensemble.
        ind_score = float(indicator_signal_row(work, i))

        # XGBoost: strict past-only training window.
        xgb_score = 0.0
        xgb_prob = 0.5
        if xgb_ok:
            train = work.iloc[max(45, i-220):i].dropna(subset=feature_cols+["target"])
            if len(train) >= 80:
                X = train[feature_cols].astype(float)
                y = train["target"].astype(int)
                if y.nunique() >= 2:
                    model = XGBClassifier(
                        n_estimators=80, max_depth=3, learning_rate=0.05,
                        subsample=0.85, colsample_bytree=0.85,
                        random_state=42, eval_metric="logloss"
                    )
                    model.fit(X, y)
                    xgb_prob = float(model.predict_proba(
                        row[feature_cols].astype(float).to_frame().T
                    )[0,1])
                    xgb_score = 2*xgb_prob - 1

        # ARIMA on log returns, again only using observations available before i.
        arima_score = 0.0
        arima_pred = 0.0
        if arima_ok:
            ret = work["ret1"].iloc[max(30, i-120):i].dropna()
            if len(ret) >= 40:
                try:
                    fit = ARIMA(ret, order=(1,0,1)).fit()
                    arima_pred = float(fit.forecast(1).iloc[0])
                    arima_score = max(-1.0, min(1.0, arima_pred / 0.01))
                except Exception:
                    pass

        # Normalize indicator score to roughly [-1, 1].
        ind_norm = max(-1.0, min(1.0, ind_score))

        # Confidence-like strength is a model score, NOT a probability.
        abs_scores = [abs(ind_norm), abs(xgb_score), abs(arima_score)]
        weights = [0.40, 0.35, 0.25]
        ensemble = (
            weights[0]*ind_norm +
            weights[1]*xgb_score +
            weights[2]*arima_score
        )
        direction = "LONG" if ensemble > threshold else (
            "SHORT" if ensemble < -threshold else "WAIT"
        )

        new_pos = 1 if direction == "LONG" else (-1 if direction == "SHORT" else 0)

        if new_pos != pos:
            next_ret = float(work.iloc[i+1].c / row.c - 1)
            audits.append({
                "time": int(row.open_time),
                "price": float(row.c),
                "action": "BUY" if new_pos == 1 else ("SELL/SHORT" if new_pos == -1 else "EXIT"),
                "direction": direction,
                "indicator_score": ind_norm,
                "xgb_score": xgb_score,
                "xgb_up_score": xgb_prob,
                "arima_score": arima_score,
                "arima_return_forecast": arima_pred,
                "ensemble_score": ensemble,
                "model_weights": {
                    "indicators": weights[0],
                    "xgboost": weights[1],
                    "arima": weights[2]
                },
                "next_bar_return": next_ret,
                "agreement": (
                    "一致" if (
                        (ind_norm > 0 and xgb_score > 0 and arima_score > 0) or
                        (ind_norm < 0 and xgb_score < 0 and arima_score < 0)
                    ) else "分歧"
                ),
                "indicator_detail": {
                    "RSI": float(row.RSI),
                    "EMA_gap_pct": float(row.ema_gap*100),
                    "MACD_gap": float(row.macd_gap),
                    "K": float(row.K),
                    "D": float(row.D),
                    "BB_position": float((row.c-row.BB_low)/max(row.BB_high-row.BB_low,1e-12))
                }
            })
            pos = new_pos

    return {
        "interval": interval,
        "days": days,
        "threshold": threshold,
        "model_status": {
            "xgboost": xgb_ok,
            "arima": arima_ok
        },
        "trades": audits
    }


@app.get("/api/adaptive_ensemble")
async def adaptive_ensemble(interval: str="1h", days: int=90, threshold: float=0.05):
    """Select ensemble weights on a validation segment, then lock them for test."""
    if interval not in INTERVALS:
        interval = "1h"
    days = max(60, min(int(days), 180))
    df = await research_frame(interval, days)
    bars_per_day = {"15m": 96, "1h": 24, "4h": 6, "1d": 1}[interval]
    n = min(len(df), days * bars_per_day)
    df = df.tail(n).reset_index(drop=True)

    if len(df) < 150:
        return {"error": "数据不足", "weights": {}, "test": {}}

    # Features.
    w = df.copy()
    w["ret1"] = w.c.pct_change()
    w["ret3"] = w.c.pct_change(3)
    w["ret6"] = w.c.pct_change(6)
    w["vol20"] = w.ret1.rolling(20).std()
    w["ema_gap"] = (w.EMA9-w.EMA21)/w.c
    w["macd_gap"] = w.MACD-w.MACD_signal
    w["vol_z"] = (w.v-w.v.rolling(20).mean())/w.v.rolling(20).std()
    w["target"] = (w.c.shift(-1) > w.c).astype(int)
    feats = ["ret1","ret3","ret6","vol20","RSI","ema_gap","macd_gap","vol_z"]

    # Three sequential sections: train / validation / test.
    n = len(w)
    tr_end = int(n*0.60)
    va_end = int(n*0.80)
    train = w.iloc[:tr_end]
    valid = w.iloc[tr_end:va_end]
    test = w.iloc[va_end:]

    try:
        from xgboost import XGBClassifier
        xgb_ok = True
    except Exception:
        xgb_ok = False
    try:
        from statsmodels.tsa.arima.model import ARIMA
        arima_ok = True
    except Exception:
        arima_ok = False

    def model_scores_at(i, history_end):
        row = w.iloc[i]
        ind = max(-1.0, min(1.0, float(indicator_signal_row(w, i))))
        xgb = 0.0
        ar = 0.0

        if xgb_ok:
            tr = w.iloc[max(45, history_end-220):history_end].dropna(subset=feats+["target"])
            if len(tr) >= 80 and tr.target.nunique() >= 2:
                m = XGBClassifier(
                    n_estimators=70, max_depth=3, learning_rate=.05,
                    subsample=.85, colsample_bytree=.85,
                    random_state=42, eval_metric="logloss"
                )
                m.fit(tr[feats], tr.target.astype(int))
                p = float(m.predict_proba(row[feats].astype(float).to_frame().T)[0,1])
                xgb = 2*p-1

        if arima_ok:
            ret = w.ret1.iloc[max(30, history_end-120):history_end].dropna()
            if len(ret) >= 40:
                try:
                    pred = float(ARIMA(ret, order=(1,0,1)).fit().forecast(1).iloc[0])
                    ar = max(-1.0, min(1.0, pred/.01))
                except Exception:
                    pass
        return [ind, xgb, ar]

    # To keep the local app responsive, validate using a sparse but chronological sample.
    candidates = [
        (a,b,1-a-b) for a in [0.20,0.35,0.50,0.65]
        for b in [0.20,0.35,0.50,0.65]
        if 0 <= 1-a-b <= 0.60
    ]
    validation_rows = []
    val_indices = list(range(tr_end+5, va_end, max(1, (va_end-tr_end)//24)))

    for weights in candidates:
        score_sum = 0.0
        hit = 0
        count = 0
        for i in val_indices:
            sc = model_scores_at(i, i)
            ens = sum(a*b for a,b in zip(weights, sc))
            actual = 1 if w.c.iloc[i+1] > w.c.iloc[i] else -1
            pred = 1 if ens > threshold else (-1 if ens < -threshold else 0)
            if pred != 0:
                score_sum += pred * (float(w.c.iloc[i+1]/w.c.iloc[i]-1))
                hit += int(pred == actual)
                count += 1
        avg = score_sum / max(count,1)
        wr = hit / max(count,1)
        objective = avg + 0.15*(wr-0.5)
        validation_rows.append({
            "weights": {"indicators":weights[0],"xgboost":weights[1],"arima":weights[2]},
            "avg_return": avg,
            "win_rate": wr,
            "objective": objective,
            "samples": count
        })

    validation_rows.sort(key=lambda x:x["objective"], reverse=True)
    chosen = validation_rows[0]["weights"]

    # Locked weights on test: no re-optimization.
    equity = 1.0
    bh = 1.0
    pos = 0
    curve = []
    trades = []

    for i in range(va_end+5, len(w)-1):
        sc = model_scores_at(i, i)
        ens = sum(a*b for a,b in zip(
            [chosen["indicators"],chosen["xgboost"],chosen["arima"]], sc
        ))
        new_pos = 1 if ens > threshold else (-1 if ens < -threshold else 0)
        p0 = float(w.c.iloc[i]); p1 = float(w.c.iloc[i+1])
        changed = new_pos != pos
        cost = .0006 if changed else 0.0
        equity *= max(0.0, 1 + pos*(p1/p0-1) - cost)
        bh *= p1/p0
        if changed:
            trades.append({
                "time": int(w.open_time.iloc[i]),
                "price": p0,
                "action": "BUY" if new_pos==1 else ("SELL/SHORT" if new_pos==-1 else "EXIT"),
                "ensemble_score": ens
            })
        pos = new_pos
        curve.append({"time":int(w.open_time.iloc[i+1]),"equity":equity,"buy_hold":bh})

    peak=1.0
    maxdd=0.0
    for p in curve:
        peak=max(peak,p["equity"])
        maxdd=max(maxdd,1-p["equity"]/peak)

    return {
        "interval":interval, "days":days, "threshold":threshold,
        "split":{"train":.60,"validation":.20,"test":.20},
        "chosen_weights":chosen,
        "validation_top":validation_rows[:8],
        "test":{
            "return":equity-1,
            "buy_hold":bh-1,
            "max_drawdown":maxdd,
            "trades":len(trades)
        },
        "curve":curve,
        "trades":trades,
        "model_status":{"xgboost":xgb_ok,"arima":arima_ok}
    }


def classify_regime(df, i):
    """Interpretable market regime classifier."""
    row = df.iloc[i]
    close = float(row.c)

    ema_gap = float((row.EMA9 - row.EMA21) / max(close, 1e-12))
    atr_proxy = float(df.c.pct_change().rolling(20).std().iloc[i])
    long_vol = float(df.c.pct_change().rolling(80).std().iloc[i])
    momentum = float(df.c.iloc[i] / df.c.iloc[max(0, i-20)] - 1.0)

    # Trend strength.
    trend = abs(ema_gap) * 100
    vol_ratio = atr_proxy / max(long_vol, 1e-9)

    if trend >= 1.2 and momentum >= 0.02:
        regime = "BULL_TREND"
    elif trend >= 1.2 and momentum <= -0.02:
        regime = "BEAR_TREND"
    elif vol_ratio >= 1.35:
        regime = "HIGH_VOL"
    else:
        regime = "RANGE"

    return {
        "regime": regime,
        "trend_strength": trend,
        "volatility": atr_proxy,
        "volatility_ratio": vol_ratio,
        "momentum_20": momentum
    }

@app.get("/api/regime")
async def regime(interval: str="1h", days: int=90):
    if interval not in INTERVALS:
        interval = "1h"
    days = max(30, min(int(days), 180))
    df = await research_frame(interval, days)
    bars_per_day = {"15m":96, "1h":24, "4h":6, "1d":1}[interval]
    df = df.tail(min(len(df), days*bars_per_day)).reset_index(drop=True)

    counts = {}
    rows = []
    for i in range(80, len(df)):
        x = classify_regime(df, i)
        counts[x["regime"]] = counts.get(x["regime"], 0) + 1
        rows.append({
            "time": int(df.open_time.iloc[i]),
            "price": float(df.c.iloc[i]),
            **x
        })

    current = rows[-1] if rows else {}
    total = max(1, len(rows))
    distribution = {
        k: {"bars": v, "pct": v/total}
        for k,v in counts.items()
    }
    return {
        "interval": interval,
        "days": days,
        "current": current,
        "distribution": distribution,
        "history": rows
    }

@app.get("/api/regime_ensemble")
async def regime_ensemble(interval: str="1h", days: int=90):
    """Use regime-specific ensemble weights and report the resulting test."""
    if interval not in INTERVALS:
        interval = "1h"
    days = max(60, min(int(days), 180))
    df = await research_frame(interval, days)
    bars_per_day = {"15m":96, "1h":24, "4h":6, "1d":1}[interval]
    df = df.tail(min(len(df), days*bars_per_day)).reset_index(drop=True)

    # Conservative, regime-aware defaults. These are research weights,
    # not probabilities and are intentionally transparent.
    regime_weights = {
        "BULL_TREND": {"indicators":.30, "xgboost":.45, "arima":.25},
        "BEAR_TREND": {"indicators":.30, "xgboost":.45, "arima":.25},
        "HIGH_VOL":   {"indicators":.45, "xgboost":.35, "arima":.20},
        "RANGE":      {"indicators":.50, "xgboost":.30, "arima":.20},
    }

    equity = 1.0
    bh = 1.0
    pos = 0
    peak = 1.0
    maxdd = 0.0
    points = []
    trades = []

    # Use indicators as the stable base; regime changes determine weighting.
    for i in range(80, len(df)-1):
        rg = classify_regime(df, i)
        weights = regime_weights[rg["regime"]]
        ind = max(-1,min(1,float(indicator_signal_row(df,i))))

        # Lightweight model proxies based only on past information.
        ret3 = float(df.c.iloc[i]/df.c.iloc[max(0,i-3)]-1)
        ret10 = float(df.c.iloc[i]/df.c.iloc[max(0,i-10)]-1)
        ema = float((df.EMA9.iloc[i]-df.EMA21.iloc[i])/df.c.iloc[i])
        xgb = max(-1,min(1, 20*ret3 + 8*ema))
        arima = max(-1,min(1, 12*ret10))

        ensemble = weights["indicators"]*ind + weights["xgboost"]*xgb + weights["arima"]*arima
        new_pos = 1 if ensemble > .05 else (-1 if ensemble < -.05 else 0)

        p0=float(df.c.iloc[i]); p1=float(df.c.iloc[i+1])
        changed=new_pos!=pos
        cost=transition_cost(pos, new_pos, .0006)
        equity *= max(0, 1 + pos*(p1/p0-1) - cost)
        bh *= p1/p0

        if changed:
            trades.append({
                "time":int(df.open_time.iloc[i]),
                "price":p0,
                "action":"BUY" if new_pos==1 else ("SELL/SHORT" if new_pos==-1 else "EXIT"),
                "regime":rg["regime"],
                "ensemble":ensemble
            })
        pos=new_pos
        peak=max(peak,equity)
        maxdd=max(maxdd,1-equity/peak)
        points.append({
            "time":int(df.open_time.iloc[i+1]),
            "equity":equity,
            "buy_hold":bh,
            "regime":rg["regime"]
        })

    return {
        "interval":interval,
        "days":days,
        "regime_weights":regime_weights,
        "current_regime":classify_regime(df,len(df)-1),
        "test":{
            "return":equity-1,
            "buy_hold":bh-1,
            "max_drawdown":maxdd,
            "trades":len(trades)
        },
        "points":points,
        "trades":trades
    }


@app.get("/api/walkforward_opt")
async def walkforward_opt(interval: str="1h", days: int=120):
    """Walk-forward optimization of regime weights and decision threshold."""
    if interval not in INTERVALS:
        interval = "1h"
    days = max(90, min(int(days), 180))
    df = await research_frame(interval, days)
    bars_per_day = {"15m":96, "1h":24, "4h":6, "1d":1}[interval]
    df = df.tail(min(len(df), days*bars_per_day)).reset_index(drop=True)

    if len(df) < 220:
        return {"error":"数据不足"}

    # Features / signals are calculated without future values.
    ret = df.c.pct_change()
    vol = ret.rolling(20).std()
    longvol = ret.rolling(80).std()

    def regime(i):
        ema_gap = float((df.EMA9.iloc[i]-df.EMA21.iloc[i])/df.c.iloc[i])
        mom = float(df.c.iloc[i]/df.c.iloc[max(0,i-20)]-1)
        vr = float(vol.iloc[i]/max(longvol.iloc[i],1e-9))
        if abs(ema_gap)*100 >= 1.2 and mom >= .02: return "BULL_TREND"
        if abs(ema_gap)*100 >= 1.2 and mom <= -.02: return "BEAR_TREND"
        if vr >= 1.35: return "HIGH_VOL"
        return "RANGE"

    # Candidate weights are deliberately small for local/zero-budget execution.
    candidates = [
        {"name":"trend","threshold":.05,
         "BULL_TREND":[.25,.50,.25],"BEAR_TREND":[.25,.50,.25],"HIGH_VOL":[.45,.35,.20],"RANGE":[.55,.30,.15]},
        {"name":"balanced","threshold":.05,
         "BULL_TREND":[.35,.40,.25],"BEAR_TREND":[.35,.40,.25],"HIGH_VOL":[.45,.35,.20],"RANGE":[.45,.35,.20]},
        {"name":"indicator","threshold":.08,
         "BULL_TREND":[.40,.35,.25],"BEAR_TREND":[.40,.35,.25],"HIGH_VOL":[.55,.30,.15],"RANGE":[.60,.25,.15]},
    ]

    # Rolling folds: each validation fold follows its own training history.
    start = 90
    end = len(df)-1
    folds = []
    cursor = start
    while cursor < end-25:
        train_end = cursor
        val_end = min(cursor+25, end)
        folds.append((train_end,val_end))
        cursor += 25

    def scores(i):
        ind=max(-1,min(1,float(indicator_signal_row(df,i))))
        r3=float(df.c.iloc[i]/df.c.iloc[max(0,i-3)]-1)
        r10=float(df.c.iloc[i]/df.c.iloc[max(0,i-10)]-1)
        ema=float((df.EMA9.iloc[i]-df.EMA21.iloc[i])/df.c.iloc[i])
        xgb=max(-1,min(1,20*r3+8*ema))
        ar=max(-1,min(1,12*r10))
        return [ind,xgb,ar]

    def eval_candidate(c, a, b):
        eq=1.0
        pos=0
        hits=0
        trades=0
        for i in range(a,b):
            rg=regime(i)
            ws=c[rg]
            sc=scores(i)
            ens=sum(ws[j]*sc[j] for j in range(3))
            new=1 if ens>c["threshold"] else (-1 if ens<-c["threshold"] else 0)
            p0=float(df.c.iloc[i]); p1=float(df.c.iloc[i+1])
            changed=new!=pos
            if changed: trades+=1
            eq*=max(0,1+pos*(p1/p0-1)-transition_cost(pos,new,.0006))
            if new and ((new==1 and p1>p0) or (new==-1 and p1<p0)): hits+=1
            pos=new
        return eq-1, hits/max(trades,1), trades

    # Select using validation folds only.
    results=[]
    for c in candidates:
        fold_returns=[]
        fold_wr=[]
        fold_trades=[]
        for a,b in folds:
            rr,wr,tt=eval_candidate(c,a,b)
            fold_returns.append(rr); fold_wr.append(wr); fold_trades.append(tt)
        avg=sum(fold_returns)/len(fold_returns)
        wr=sum(fold_wr)/len(fold_wr)
        stability=max(fold_returns)-min(fold_returns)
        objective=avg + .10*(wr-.5) - .15*max(0,stability)
        results.append({
            "name":c["name"],"threshold":c["threshold"],
            "avg_validation_return":avg,
            "avg_validation_win_rate":wr,
            "fold_spread":stability,
            "objective":objective,
            "trades":sum(fold_trades)
        })

    results.sort(key=lambda x:x["objective"],reverse=True)
    chosen_name=results[0]["name"]
    chosen=next(x for x in candidates if x["name"]==chosen_name)

    # Final test is the last 20% and uses the locked candidate only.
    test_start=max(int(len(df)*.8), folds[-1][1] if folds else int(len(df)*.8))
    test_ret, test_wr, test_trades=eval_candidate(chosen,test_start,end)

    return {
        "interval":interval,
        "days":days,
        "folds":len(folds),
        "chosen":chosen,
        "validation_ranking":results,
        "test_start_index":test_start,
        "test":{
            "return":test_ret,
            "win_rate":test_wr,
            "trades":test_trades
        },
        "method":"walk-forward validation; candidate locked before final test"
    }


@app.get("/api/health_check")
async def health_check(interval: str="1h", days: int=180):
    """Research-grade strategy health / robustness report."""
    if interval not in INTERVALS:
        interval="1h"
    days=max(90,min(int(days),180))
    df=await research_frame(interval, days)
    bars={"15m":96,"1h":24,"4h":6,"1d":1}[interval]
    df=df.tail(min(len(df),days*bars)).reset_index(drop=True)
    if len(df)<220:
        return {"error":"数据不足"}

    def ret_slice(a,b,fee=.0006,slip=.0002):
        eq=1.0; bh=1.0; pos=0; trades=0; wins=0
        daily=[]
        for i in range(a,min(b,len(df)-1)):
            sc=float(indicator_signal_row(df,i))
            new=1 if sc>.05 else (-1 if sc<-.05 else 0)
            p0=float(df.c.iloc[i]); p1=float(df.c.iloc[i+1])
            changed=new!=pos
            if changed: trades+=1
            r=pos*(p1/p0-1)-transition_cost(pos,new,fee+slip)
            eq*=max(0,1+r)
            if changed and new!=0 and ((new==1 and p1>p0) or (new==-1 and p1<p0)):
                wins+=1
            bh*=p1/p0
            daily.append(eq)
            pos=new
        peak=1.0; mdd=0
        for x in daily:
            peak=max(peak,x); mdd=min(mdd,x/peak-1)
        n=max(len(daily),1)
        sharpe=((eq**(1/n)-1)/(max(abs(mdd),1e-6)**.5))*((n)**.5) if n>5 else 0
        return {"return":eq-1,"buy_hold":bh-1,"max_drawdown":mdd,
                "trades":trades,"win_rate":wins/max(trades,1),"sharpe_proxy":sharpe}

    n=len(df)
    thirds=[(0,n//3),(n//3,2*n//3),(2*n//3,n-1)]
    regimes={}
    for name,(a,b) in {
        "early":thirds[0],"middle":thirds[1],"late":thirds[2]
    }.items():
        regimes[name]=ret_slice(max(80,a),b)

    costs=[]
    for fee in [0,.0003,.0006,.001,.002]:
        x=ret_slice(80,n-1,fee,fee/2)
        costs.append({"fee":fee,"return":x["return"],"max_drawdown":x["max_drawdown"],
                      "trades":x["trades"]})

    # Parameter-neighborhood sensitivity: threshold around baseline.
    sensitivity=[]
    base=.05
    for th in [.02,.03,.04,.05,.06,.07,.08,.10]:
        eq=1.; pos=0
        for i in range(80,n-1):
            sc=float(indicator_signal_row(df,i))
            new=1 if sc>th else (-1 if sc<-th else 0)
            p0=float(df.c.iloc[i]); p1=float(df.c.iloc[i+1])
            changed=new!=pos
            eq*=max(0,1+pos*(p1/p0-1)-transition_cost(pos,new,.0008))
            pos=new
        sensitivity.append({"threshold":th,"return":eq-1})

    full=ret_slice(80,n-1)
    stability_returns=[v["return"] for v in regimes.values()]
    spread=max(stability_returns)-min(stability_returns)
    positive=sum(1 for x in stability_returns if x>0)
    cost_return=costs[-1]["return"]
    sens=[x["return"] for x in sensitivity]
    sens_spread=max(sens)-min(sens)

    # Heuristic diagnostic score, explicitly not a probability.
    score=100
    if positive<2: score-=25
    if spread>.30: score-=20
    if cost_return<0: score-=20
    if full["max_drawdown"]<-.35: score-=15
    if sens_spread>.45: score-=15
    score=max(0,min(100,score))

    flags=[]
    if positive<2: flags.append("不同时间段表现不稳定")
    if spread>.30: flags.append("时间段收益差异较大")
    if cost_return<0: flags.append("高交易成本下收益转负")
    if full["max_drawdown"]<-.35: flags.append("最大回撤偏高")
    if sens_spread>.45: flags.append("参数附近敏感，存在过拟合风险")
    if not flags: flags.append("当前样本下未发现明显异常，但仍需更长历史验证")

    return {
        "interval":interval,"days":days,
        "overall":full,
        "periods":regimes,
        "cost_sensitivity":costs,
        "parameter_sensitivity":sensitivity,
        "stability_score":score,
        "diagnostics":flags,
        "note":"稳定性分数是研究型启发式指标，不代表未来盈利概率。"
    }

@app.get("/api/model_compare")
async def model_compare(interval: str="1h", days: int=30):
    if interval not in {"15m","1h","4h","1d"}:
        return {"error":"invalid interval"}
    days=max(7,min(days,180))
    try:
        df=await fetch_history(interval, days)
        step={"15m":15,"1h":60,"4h":240,"1d":1440}[interval]
        keep=min(len(df),days*(1440//step)+130)
        df=df.tail(keep).reset_index(drop=True)
        base=await backtest_interval(interval,days,10,5)
        py={"15m":35040,"1h":8760,"4h":2190,"1d":365}[interval]
        xb,xe=xgb_walkforward(df, fee_bps=10, slippage_bps=5, periods_year=py)
        ar,ae=arima_forecast_walkforward(df, fee_bps=10, slippage_bps=5, periods_year=py)
        return {"interval":interval,"days":days,
                "results":[x for x in [base,xb,ar] if x],
                "errors":{"xgboost":xe,"arima":ae}}
    except Exception as e:
        return {"error":str(e)}

# ---------------- Backtest engine ----------------
def indicator_signal_row(df, i):
    sub = df.iloc[:i+1]
    v = vote_components(sub)
    w = adaptive_weights(sub) if len(sub) >= 45 else DEFAULT_W
    return score_from_votes(v, w)

async def backtest_interval(interval="1h", days=90, fee_bps=10, slippage_bps=5):
    """Unified next-bar backtest. All costs are charged only on exposure changes."""
    bars_per_day={"15m":96,"1h":24,"4h":6,"1d":1}
    df=await fetch_history(interval, days)
    keep=min(len(df), days*bars_per_day[interval]+60)
    df=df.tail(keep).reset_index(drop=True)
    signals={}
    for i in range(45,len(df)-1):
        sig=indicator_signal_row(df,i)
        signals[i]=1 if sig>0.05 else (-1 if sig<-0.05 else 0)
    out=backtest_positions(df,signals,start=45,fee_bps=fee_bps,slippage_bps=slippage_bps)
    out.update({"strategy":"Adaptive Indicator Vote","interval":interval,"days":days,
                "fee_bps":fee_bps,"slippage_bps":slippage_bps})
    return out


def _risk_features(df):
    """Vectorized causal risk features; each row uses data at or before that close."""
    tr = pd.concat([
        df.h-df.l,
        (df.h-df.c.shift(1)).abs(),
        (df.l-df.c.shift(1)).abs()
    ], axis=1).max(axis=1)
    atr_pct = tr.rolling(14, min_periods=14).mean() / df.c.replace(0, np.nan)
    ret = df.c.pct_change()
    vol_ann = ret.rolling(20, min_periods=20).std() * math.sqrt(8760)
    ema_gap = (df.EMA9-df.EMA21)/df.c.replace(0,np.nan)
    short_vol = ret.rolling(20, min_periods=20).std()
    long_vol = ret.rolling(80, min_periods=80).std()
    momentum = df.c/df.c.shift(20)-1
    trend = ema_gap.abs()*100
    ratio = short_vol/long_vol.replace(0,np.nan)
    regimes=np.where((trend>=1.2)&(momentum>=0.02),'BULL_TREND',
             np.where((trend>=1.2)&(momentum<=-0.02),'BEAR_TREND',
             np.where(ratio>=1.35,'HIGH_VOL','RANGE')))
    return atr_pct.fillna(0.02), vol_ann.fillna(0.20), regimes.tolist()


def _causal_vote(df, i, weights):
    row=df.iloc[i]
    rr=float(row.RSI); k=float(row.K); d=float(row.D)
    vals={
        'RSI': 1 if 50 < rr < 70 else (-1 if 30 < rr < 50 else 0),
        'MACD': 1 if row.MACD > row.MACD_signal else -1,
        'EMA': 1 if row.EMA9 > row.EMA21 else -1,
        'KDJ': 1 if k > d else -1,
        'BOLL': 1 if row.c > row.BB_mid else -1,
    }
    return score_from_votes(vals, weights)


def risk_managed_backtest(df, threshold=0.05, fee_bps=10, slippage_bps=5,
                          baseline=1.0, max_position=1.0):
    """Causal dynamic-position backtest with decoupled signal and risk sizing."""
    if len(df) < 100:
        return {"error":"insufficient_data"}
    df=prepare_features(df)
    atr, vol, regimes = _risk_features(df)
    equity=1.0; peak=1.0; pos=0.0; trades=0; wins=0; returns=[]; curve=[]
    unit_cost=(fee_bps+slippage_bps)/10000.0
    day_start_equity=1.0; current_day=None; daily_loss=0.0
    weight_cache={}
    for i in range(80, len(df)-1):
        ts=pd.Timestamp(df.open_time.iloc[i], unit='ms', tz='UTC'); day=ts.date()
        if day != current_day:
            current_day=day; day_start_equity=equity
        daily_loss=max(0.0,(day_start_equity-equity)/max(day_start_equity,1e-12)*100)
        dd=max(0.0,(peak-equity)/max(peak,1e-12)*100)
        key=i//20
        if key not in weight_cache:
            weight_cache[key]=adaptive_weights(df.iloc[:i+1]) if i>=45 else DEFAULT_W.copy()
        score=_causal_vote(df,i,weight_cache[key])
        direction=1 if score>threshold else (-1 if score<-threshold else 0)
        risk=risk_engine(score,float(atr.iloc[i]),float(vol.iloc[i]),dd,daily_loss,regimes[i],baseline,max_position)
        target=direction*float(risk['position_factor'])
        p0=float(df.c.iloc[i]); p1=float(df.c.iloc[i+1])
        changed=abs(target-pos)>1e-9
        cost=abs(target-pos)*unit_cost if changed else 0.0
        bar_ret=pos*(p1/p0-1.0); net=bar_ret-cost
        old_equity=equity; equity*=max(0.0,1+net)
        if changed:
            trades+=1
            if pos!=0 and equity>old_equity: wins+=1
        returns.append(net); peak=max(peak,equity); pos=target
        curve.append({"time":int(df.open_time.iloc[i+1]),"equity":equity,
                      "drawdown":max(0,1-equity/peak),"position":pos,
                      "score":float(score),"risk_level":risk['risk_level'],
                      "regime":regimes[i],"volatility_factor":risk['volatility_factor'],
                      "atr_factor":risk['atr_factor']})
    arr=np.asarray(returns,dtype=float); sd=arr.std(ddof=1) if len(arr)>1 else 0
    sharpe=float(arr.mean()/sd*math.sqrt(8760)) if sd>1e-12 else 0.0
    mdd=max((x['drawdown'] for x in curve),default=0)
    return {"total_return":round((equity-1)*100,2),"max_drawdown":round(mdd*100,2),
            "sharpe":round(sharpe,2),"trades":trades,"win_rate":round(100*wins/max(trades,1),2),
            "final_equity":round(equity,4),"curve":curve[-500:]}



def portfolio_backtest(df, scores=None, initial_capital=10000.0, fee_bps=10, slippage_bps=5,
                       baseline=1.0, max_position=1.0, max_drawdown=15.0,
                       max_daily_loss=3.0, regime="NORMAL"):
    """Account-level causal equity engine.

    Target exposure is a signed fraction of equity. Signal is observed at close i and
    target exposure is held on i->i+1. Transaction cost is charged on the absolute
    change in exposure, so a reversal pays for both legs. Risk limits are evaluated
    using information available through i only.
    """
    if len(df) < 3:
        return {"initial_capital": float(initial_capital), "final_equity": float(initial_capital),
                "total_return_pct": 0.0, "max_drawdown_pct": 0.0, "trades": 0, "curve": []}
    work=prepare_features(df.reset_index(drop=True))
    scores=scores or {}
    equity=float(initial_capital); peak=equity; exposure=0.0; trades=0
    unit_cost=(float(fee_bps)+float(slippage_bps))/10000.0
    curve=[]; day_start=equity; current_day=None
    killed=False
    atr_series, vol_series, regimes = _risk_features(work)
    weight_cache={}
    generated_scores={}
    for i in range(45, len(work)-1):
        key=i//20
        if key not in weight_cache:
            weight_cache[key]=adaptive_weights(work.iloc[:i+1]) if i>=45 else DEFAULT_W.copy()
        generated_scores[i]=_causal_vote(work, i, weight_cache[key])
    for i in range(45, len(work)-1):
        ts=pd.to_datetime(int(work.open_time.iloc[i]), unit='ms', utc=True)
        day=str(ts.date())
        if day != current_day:
            current_day=day; day_start=equity; killed=False
        score=float(scores[i] if i in scores else generated_scores[i])
        atr_pct=float(atr_series.iloc[i])
        vol_ann=float(vol_series.iloc[i])
        drawdown=max(0.0,1.0-equity/peak)*100
        daily_loss=max(0.0,1.0-equity/day_start)*100
        rg=regimes[i]
        risk=risk_engine(score, atr_pct, vol_ann, drawdown, daily_loss, rg,
                         baseline=baseline, max_position=max_position,
                         max_drawdown=max_drawdown, max_daily_loss=max_daily_loss)
        target=(risk['position_factor'] if risk['direction']=='LONG' else
                -risk['position_factor'] if risk['direction']=='SHORT' else 0.0)
        if risk['risk_level']=='KILL_SWITCH':
            target=0.0; killed=True
        delta=abs(target-exposure)
        cost=equity*delta*unit_cost
        if delta>1e-12: trades += 1
        p0=float(work.c.iloc[i]); p1=float(work.c.iloc[i+1])
        bar_ret=exposure*(p1/p0-1.0)
        equity=max(0.0, equity*(1.0+bar_ret)-cost)
        exposure=target
        peak=max(peak,equity)
        dd=max(0.0,1.0-equity/peak)
        curve.append({"time":int(work.open_time.iloc[i+1]),"equity":equity,
                      "return_pct":(equity/initial_capital-1)*100,
                      "drawdown_pct":dd*100,"position":exposure,
                      "risk_level":risk['risk_level'],"regime":rg,"killed":killed})
    final=equity; total=(final/initial_capital-1)*100
    mdd=max((x['drawdown_pct'] for x in curve),default=0.0)
    return {"initial_capital":float(initial_capital),"final_equity":round(final,4),
            "total_return_pct":round(total,4),"max_drawdown_pct":round(mdd,4),
            "trades":trades,"curve":curve}


def data_integrity_report(df, interval):
    """Audit chronological completeness before any research result is trusted."""
    x=df.copy().sort_values("open_time").drop_duplicates("open_time").reset_index(drop=True)
    expected_ms={"15m":15*60_000,"1h":60*60_000,"4h":4*60*60_000,"1d":24*60*60_000}[interval]
    ts=pd.to_numeric(x["open_time"], errors="coerce")
    gaps=ts.diff().dropna()
    bad_gaps=int((gaps != expected_ms).sum())
    duplicate_count=int(len(df)-len(x))
    nan_ohlc=int(x[["o","h","l","c","v"]].isna().any(axis=1).sum())
    bad_ohlc=int(((x.h < x.l) | (x.h < x.o) | (x.h < x.c) | (x.l > x.o) | (x.l > x.c) | (x.v < 0)).sum())
    return {
        "rows":int(len(x)), "duplicates_removed":duplicate_count,
        "gap_count":bad_gaps, "nan_ohlcv_rows":nan_ohlc, "invalid_ohlcv_rows":bad_ohlc,
        "first_open_time":int(ts.iloc[0]) if len(ts) else None,
        "last_open_time":int(ts.iloc[-1]) if len(ts) else None,
        "complete_enough": bool(len(x)>100 and bad_gaps==0 and nan_ohlc==0 and bad_ohlc==0),
        "expected_interval_ms":expected_ms,
    }


def _comparison_features(df):
    x=df.copy().reset_index(drop=True)
    ret=x.c.pct_change()
    ema_gap=(x.EMA9-x.EMA21)/x.c.replace(0,np.nan)
    ind=[]; trend=[]; xgb=[]; ar=[]; regimes=[]; factors=[]
    for i in range(len(x)):
        if i<45:
            ind.append(0.0); trend.append(0.0); xgb.append(0.0); ar.append(0.0); regimes.append('RANGE'); factors.append(1.0); continue
        # Vectorized causal indicator vote; avoid per-row dataframe slicing in research loops.
        vals=(
            (1 if 50 < float(x.RSI.iloc[i]) < 70 else (-1 if 30 < float(x.RSI.iloc[i]) < 50 else 0)) * DEFAULT_W['RSI'] +
            (1 if float(x.MACD.iloc[i]) > float(x.MACD_signal.iloc[i]) else -1) * DEFAULT_W['MACD'] +
            (1 if float(x.EMA9.iloc[i]) > float(x.EMA21.iloc[i]) else -1) * DEFAULT_W['EMA'] +
            (1 if float(x.K.iloc[i]) > float(x.D.iloc[i]) else -1) * DEFAULT_W['KDJ'] +
            (1 if float(x.c.iloc[i]) > float(x.BB_mid.iloc[i]) else -1) * DEFAULT_W['BOLL']
        )
        ind.append(float(vals))
        trend.append(max(-1,min(1,25*float(ema_gap.iloc[i])+8*float(x.c.iloc[i]/x.c.iloc[max(0,i-10)]-1))))
        xgb.append(max(-1,min(1,20*float(x.c.iloc[i]/x.c.iloc[max(0,i-3)]-1)+8*float(ema_gap.iloc[i]))))
        ar.append(max(-1,min(1,12*float(x.c.iloc[i]/x.c.iloc[max(0,i-10)]-1))))
        regimes.append(classify_regime(x,i)['regime'])
        vol=float(ret.rolling(20).std().iloc[i])
        factors.append(max(.25,min(1.0,.012/max(vol,.003))))
    return {'indicator':np.asarray(ind),'trend':np.asarray(trend),'xgb':np.asarray(xgb),'ar':np.asarray(ar),'regime':regimes,'risk_factor':np.asarray(factors)}


def _comparison_signal(feats, i, kind):
    if kind=='buy_hold': return 1.0
    if kind=='trend': return float(feats['trend'][i])
    if kind=='indicator': return float(feats['indicator'][i])
    if kind=='ensemble': return float(.5*feats['indicator'][i]+.3*feats['xgb'][i]+.2*feats['ar'][i])
    weights={'BULL_TREND':(.30,.45,.25),'BEAR_TREND':(.30,.45,.25),'HIGH_VOL':(.45,.35,.20),'RANGE':(.50,.30,.20)}[feats['regime'][i]]
    score=weights[0]*feats['indicator'][i]+weights[1]*feats['xgb'][i]+weights[2]*feats['ar'][i]
    return float(score)


def _run_comparison_oos(df, kind, start, end, fee_bps, slippage_bps, initial_capital=10000.0, feats=None):
    feats=feats or _comparison_features(df)
    unit=(float(fee_bps)+float(slippage_bps))/10000.0
    equity=float(initial_capital); peak=equity; exposure=0.0; trades=0; wins=0
    curve=[]; returns=[]
    for i in range(start, max(start,end-1)):
        score=_comparison_signal(feats,i,kind)
        target=1.0 if kind=='buy_hold' else (1.0 if score>.05 else (-1.0 if score<-.05 else 0.0))
        if kind=='adaptive_risk': target*=float(feats['risk_factor'][i])
        delta=abs(target-exposure); cost_rate=delta*unit
        p0=float(df.c.iloc[i]); p1=float(df.c.iloc[i+1]); bar=exposure*(p1/p0-1.0); net=bar-cost_rate
        old=equity; equity=max(0.0,equity*(1+net))
        if delta>1e-12:
            trades+=1; wins+=int(equity>old)
        returns.append(net); peak=max(peak,equity)
        curve.append({'time':int(df.open_time.iloc[i+1]),'equity':equity,'drawdown_pct':max(0,1-equity/peak)*100,'position':target})
        exposure=target
    arr=np.asarray(returns,dtype=float); sd=float(arr.std(ddof=1)) if len(arr)>1 else 0.0
    sharpe=float(arr.mean()/sd*np.sqrt(8760)) if sd>1e-12 else 0.0
    return {'final_equity':equity,'return_pct':(equity/initial_capital-1)*100,'max_drawdown_pct':max((x['drawdown_pct'] for x in curve),default=0),'sharpe':sharpe,'trades':trades,'win_rate_pct':100*wins/max(trades,1),'curve':curve}


def _select_adaptive_policy(df, train_start, train_end, fee_bps, slippage_bps, feats=None):
    # Policy selection is training-only. OOS is never inspected here.
    candidates=['trend','indicator','ensemble']
    rows=[]
    for k in candidates:
        r=_run_comparison_oos(df,k,train_start,train_end,fee_bps,slippage_bps,feats=feats)
        rows.append({'strategy':k,'return_pct':r['return_pct'],'sharpe':r['sharpe'],'max_drawdown_pct':r['max_drawdown_pct']})
    rows.sort(key=lambda x:(x['sharpe'],x['return_pct']),reverse=True)
    return rows[0]['strategy'],rows


def adaptive_static_comparison(df, train_bars=240, test_bars=120, step_bars=120,
                               fee_bps=10, slippage_bps=5, initial_capital=10000.0):
    """Strict OOS comparison: static baselines vs adaptive policies.
    Policy selection for adaptive variants is training-only; all models share OOS folds/costs.
    """
    work=prepare_features(df.reset_index(drop=True))
    feats=_comparison_features(work)
    kinds=['buy_hold','trend','indicator','ensemble','adaptive','adaptive_risk']
    folds=[]; aggregate={k:{'final_equity':initial_capital,'returns':[],'trades':0} for k in kinds+['adaptive_selected']}
    start=train_bars
    while start+test_bars<=len(work):
        train_start=max(45,start-train_bars); train_end=start; test_end=start+test_bars
        selected, selection_rows=_select_adaptive_policy(work,train_start,train_end,fee_bps,slippage_bps,feats)
        fold={'train_start':int(work.open_time.iloc[train_start]),'train_end':int(work.open_time.iloc[train_end-1]),
              'oos_start':int(work.open_time.iloc[start]),'oos_end':int(work.open_time.iloc[test_end-1]),
              'selected_policy':selected,'training_selection':selection_rows,'strategies':{}}
        for k in kinds:
            r=_run_comparison_oos(work,k,start,test_end,fee_bps,slippage_bps,initial_capital,feats)
            fold['strategies'][k]={x:r[x] for x in ['return_pct','max_drawdown_pct','sharpe','trades','win_rate_pct']}
            aggregate[k]['returns'].append(r['return_pct']); aggregate[k]['trades']+=r['trades']
        # Adaptive policy itself uses the training winner, then applies it only to OOS.
        adaptive_oos=_run_comparison_oos(work,selected,start,test_end,fee_bps,slippage_bps,initial_capital,feats)
        fold['strategies']['adaptive_selected']={x:adaptive_oos[x] for x in ['return_pct','max_drawdown_pct','sharpe','trades','win_rate_pct']}
        aggregate['adaptive_selected']['returns'].append(adaptive_oos['return_pct']); aggregate['adaptive_selected']['trades']+=adaptive_oos['trades']
        folds.append(fold); start+=step_bars
    summary={}
    for k,v in aggregate.items():
        rr=v['returns']; summary[k]={'folds':len(rr),'mean_oos_return_pct':float(np.mean(rr)) if rr else 0.0,
            'median_oos_return_pct':float(np.median(rr)) if rr else 0.0,
            'positive_fold_pct':100*sum(x>0 for x in rr)/max(len(rr),1),'worst_fold_pct':float(min(rr)) if rr else 0.0,
            'total_trades':v['trades']}
    return {'status':'OK' if folds else 'REJECT_DATA','folds':folds,'summary':summary,
            'method':{'train_bars':train_bars,'test_bars':test_bars,'step_bars':step_bars,
                      'fee_bps':fee_bps,'slippage_bps':slippage_bps,'selection':'training_only'}}

@app.get('/api/adaptive_static_comparison')
async def api_adaptive_static_comparison(interval: str='1h', days: int=180, train_bars: int=240,
                                         test_bars: int=120, step_bars: int=120,
                                         fee_bps: float=10, slippage_bps: float=5):
    if interval not in INTERVALS: interval='1h'
    days=max(60,min(int(days),365)); train_bars=max(100,min(int(train_bars),2000)); test_bars=max(30,min(int(test_bars),1000)); step_bars=max(30,min(int(step_bars),1000))
    df=await research_frame(interval,days)
    return adaptive_static_comparison(df,train_bars,test_bars,step_bars,fee_bps,slippage_bps)

@app.get("/api/research_report")
async def api_research_report(interval: str="1h", days: int=90, initial_capital: float=10000,
                              fee_bps: float=10, slippage_bps: float=5):
    """One research gate: data audit -> portfolio -> cost stress -> verdict."""
    if interval not in INTERVALS:
        interval="1h"
    days=max(30,min(int(days),365))
    try:
        df=await research_frame(interval, days)
        audit=data_integrity_report(df, interval)
        if not audit["complete_enough"]:
            return {"status":"REJECT_DATA","audit":audit,
                    "reason":"数据完整性未通过，禁止把收益/Sharpe 当成研究结论。"}
        base=portfolio_backtest(df,initial_capital=initial_capital,fee_bps=fee_bps,slippage_bps=slippage_bps)
        stress=[]
        for fee,slip in [(5,2),(10,5),(20,10),(40,20),(80,40)]:
            r=portfolio_backtest(df,initial_capital=initial_capital,fee_bps=fee,slippage_bps=slip)
            stress.append({"fee_bps":fee,"slippage_bps":slip,"final_equity":r["final_equity"],
                           "return_pct":r["total_return_pct"],"max_drawdown_pct":r["max_drawdown_pct"],"trades":r["trades"]})
        stress_positive=stress[-1]["return_pct"] >= 0
        verdict="ROBUST" if base["total_return_pct"]>0 and stress_positive else ("FRAGILE" if base["total_return_pct"]>0 else "REJECT")
        return {"status":"OK","verdict":verdict,"audit":audit,"base":base,"cost_stress":stress,
                "research_rule":"只有数据审计通过后，才允许解释收益；最终结论必须同时看基准与高成本压力。"}
    except Exception as e:
        return {"status":"ERROR","error":str(e)}

@app.get("/api/portfolio_backtest")
async def api_portfolio_backtest(interval: str="1h", days: int=90, initial_capital: float=10000,
                                 fee_bps: float=10, slippage_bps: float=5, max_position: float=1.0):
    if interval not in INTERVALS: interval="1h"
    days=max(30,min(int(days),180)); initial_capital=max(1.0,float(initial_capital))
    df=await fetch_history(interval,days)
    return {"interval":interval,"days":days,**portfolio_backtest(
        df, initial_capital=initial_capital, fee_bps=fee_bps,
        slippage_bps=slippage_bps, max_position=max_position)}

@app.get("/api/portfolio_stress")
async def api_portfolio_stress(interval: str="1h", days: int=90, initial_capital: float=10000):
    if interval not in INTERVALS: interval="1h"
    df=await fetch_history(interval,max(30,min(int(days),180)))
    rows=[]
    for fee,slip in [(5,2),(10,5),(20,10),(40,20),(80,40)]:
        r=portfolio_backtest(df,initial_capital=initial_capital,fee_bps=fee,slippage_bps=slip)
        rows.append({"fee_bps":fee,"slippage_bps":slip,"final_equity":r['final_equity'],
                     "return_pct":r['total_return_pct'],"max_drawdown_pct":r['max_drawdown_pct'],
                     "trades":r['trades']})
    return {"interval":interval,"days":int(days),"initial_capital":float(initial_capital),"rows":rows}

@app.get("/api/risk_backtest")
async def api_risk_backtest(interval: str="1h", days: int=90, threshold: float=0.05,
                            fee_bps: float=10, slippage_bps: float=5):
    if interval not in INTERVALS:
        interval="1h"
    days=max(30,min(int(days),180))
    try:
        df=await research_frame(interval,days)
        return {"interval":interval,"days":days,"threshold":threshold,
                "strategy":"Risk-managed Adaptive Vote",
                **risk_managed_backtest(df,threshold,fee_bps,slippage_bps)}
    except Exception as e:
        return {"error":str(e)}


@app.get("/api/risk_stress")
async def api_risk_stress(interval: str="1h", days: int=90, threshold: float=0.05):
    """Cost/volatility stress grid; ranking is by drawdown-aware stability, not return alone."""
    if interval not in INTERVALS:
        interval="1h"
    days=max(30,min(int(days),180))
    df=await research_frame(interval,days)
    rows=[]
    for fee,slip in [(5,2),(10,5),(20,10),(40,20),(80,40)]:
        x=risk_managed_backtest(df,threshold,fee,slip)
        stability=round(x['total_return'] - 1.5*x['max_drawdown'] + 5*min(x['sharpe'],2),2)
        rows.append({"fee_bps":fee,"slippage_bps":slip,"return_pct":x['total_return'],
                     "max_drawdown_pct":x['max_drawdown'],"sharpe":x['sharpe'],
                     "trades":x['trades'],"stability_score":stability})
    return {"interval":interval,"days":days,"rows":rows,
            "rule":"优先看成本压力下的回撤/Sharpe稳定性，不按单一最高收益选策略。"}

@app.get("/api/backtest")
async def api_backtest(interval: str="1h", days: int=90, fee_bps: float=10, slippage_bps: float=5):
    allowed={"15m","1h","4h","1d"}
    if interval not in allowed:
        return {"error":"interval must be 15m, 1h, 4h or 1d"}
    days=max(7,min(days,365))
    try:
        return await backtest_interval(interval, days, fee_bps, slippage_bps)
    except Exception as e:
        return {"error":str(e)}

# ---------------- Adaptive Ensemble ----------------
def historical_strategy_score(df, kind, start=70):
    """Estimate recent out-of-sample direction hit rate with rolling signals."""
    df=prepare_features(df)
    hits=0; total=0
    recent=[]
    for i in range(start, len(df)-1):
        if kind=="indicator":
            sig=indicator_signal_row(df,i)
            pred=1 if sig>.05 else (-1 if sig<-.05 else 0)
        elif kind=="xgb":
            try:
                from xgboost import XGBClassifier
                X=ml_features(df); y=(df.c.shift(-1)>df.c).astype(int)
                train=pd.concat([X.iloc[:i],y.iloc[:i]],axis=1).dropna()
                if len(train)<80: continue
                model=XGBClassifier(n_estimators=80,max_depth=3,learning_rate=.05,
                    subsample=.85,colsample_bytree=.85,objective="binary:logistic",
                    eval_metric="logloss",random_state=42,n_jobs=1)
                model.fit(train[X.columns],train[0])
                row=X.iloc[[i]]
                if row.isna().any(axis=None): continue
                pr=float(model.predict_proba(row[X.columns])[0,1])
                pred=1 if pr>.55 else (-1 if pr<.45 else 0)
            except Exception: continue
        else: # arima
            try:
                from statsmodels.tsa.arima.model import ARIMA
                lr=np.log(df.c).diff().dropna()
                if i-1 >= len(lr): continue
                fit=ARIMA(lr.iloc[:i],order=(1,0,1),trend="c").fit()
                pred=1 if float(fit.forecast(1).iloc[0])>0 else -1
            except Exception: continue
        actual=1 if df.c.iloc[i+1]>df.c.iloc[i] else -1
        if pred!=0:
            total+=1; hits+=int(pred==actual)
            recent.append(int(pred==actual))
    acc=hits/total if total else .5
    return acc, total

@app.get("/api/ensemble")
async def api_ensemble(interval: str="1h", days: int=30):
    if interval not in {"15m","1h","4h","1d"}:
        return {"error":"invalid interval"}
    days=max(7,min(days,120))
    try:
        df=await fetch_history(interval, days)
        step={"15m":15,"1h":60,"4h":240,"1d":1440}[interval]
        keep=min(len(df),days*(1440//step)+140)
        df=df.tail(keep).reset_index(drop=True)

        models=["indicator","xgb","arima"]
        acc={}
        counts={}
        for m in models:
            a,n=historical_strategy_score(df,m,start=70)
            acc[m]=a; counts[m]=n

        # Shrink estimates toward 50% to reduce overfitting from small samples.
        raw={m:0.5+0.6*(acc[m]-0.5) for m in models}
        raw={m:max(0.10,min(0.80,v)) for m,v in raw.items()}
        total=sum(raw.values())
        weights={m:round(raw[m]/total,4) for m in models}

        # Current predictions
        ind_sig=indicator_signal_row(df,len(df)-2)
        ind_pred=1 if ind_sig>.05 else (-1 if ind_sig<-.05 else 0)

        xgb_pred=0; xgb_prob=.5
        try:
            from xgboost import XGBClassifier
            X=ml_features(df); y=(df.c.shift(-1)>df.c).astype(int)
            i=len(df)-2
            train=pd.concat([X.iloc[:i],y.iloc[:i]],axis=1).dropna()
            model=XGBClassifier(n_estimators=120,max_depth=3,learning_rate=.05,
                subsample=.85,colsample_bytree=.85,objective="binary:logistic",
                eval_metric="logloss",random_state=42,n_jobs=1)
            model.fit(train[X.columns],train[0])
            row=X.iloc[[i]]
            xgb_prob=float(model.predict_proba(row[X.columns])[0,1])
            xgb_pred=1 if xgb_prob>.55 else (-1 if xgb_prob<.45 else 0)
        except Exception as e:
            xgb_error=str(e)

        ar_pred=0; ar_value=0
        try:
            from statsmodels.tsa.arima.model import ARIMA
            lr=np.log(df.c).diff().dropna()
            fit=ARIMA(lr.iloc[:-1],order=(1,0,1),trend="c").fit()
            ar_value=float(fit.forecast(1).iloc[0])
            ar_pred=1 if ar_value>0 else -1
        except Exception as e:
            ar_error=str(e)

        preds={"indicator":ind_pred,"xgb":xgb_pred,"arima":ar_pred}
        ensemble_score=sum(weights[m]*preds[m] for m in models)
        confidence=50+50*ensemble_score

        # No-trade / neutral zone to reduce overtrading.
        action="LONG" if confidence>=58 else ("SHORT" if confidence<=42 else "WAIT")

        return {
            "interval":interval,"days":days,
            "accuracy":{"indicator":round(acc["indicator"]*100,2),
                        "xgb":round(acc["xgb"]*100,2),
                        "arima":round(acc["arima"]*100,2)},
            "samples":counts,
            "weights":weights,
            "predictions":preds,
            "xgb_probability":round(xgb_prob*100,2),
            "arima_return":round(ar_value*100,4),
            "ensemble_score":round(confidence,2),
            "action":action,
            "note":"评分不是真实概率；WAIT 区间用于降低噪声交易。"
        }
    except Exception as e:
        return {"error":str(e)}

# ---------------- Research Committee ----------------
@app.get("/api/research_committee")
async def research_committee(interval: str="1h", days: int=120):
    """Strict OOS model comparison under identical execution/cost assumptions."""
    if interval not in {"15m","1h","4h","1d"}:
        return {"error":"invalid interval"}
    days=max(30,min(int(days),180))
    try:
        df=await research_frame(interval, days)
        py=BARS_PER_YEAR[interval]
        base=await backtest_interval(interval,days,10,5)
        xb,xe=xgb_walkforward(df,min_train=120,fee_bps=10,slippage_bps=5,periods_year=py)
        ar,ae=arima_forecast_walkforward(df,min_train=80,fee_bps=10,slippage_bps=5,periods_year=py)
        results=[x for x in [base,xb,ar] if x]
        # Same models, untouched cost stress; this is a robustness check, not parameter selection.
        stress=[]
        for fb,sb in [(5,2),(10,5),(20,10),(40,20)]:
            row={"fee_bps":fb,"slippage_bps":sb}
            row["indicator"]=(await backtest_interval(interval,days,fb,sb))["total_return"]
            xbs,_=xgb_walkforward(df,min_train=120,fee_bps=fb,slippage_bps=sb,periods_year=py)
            ars,_=arima_forecast_walkforward(df,min_train=80,fee_bps=fb,slippage_bps=sb,periods_year=py)
            row["xgboost"]=xbs["total_return"] if xbs else None
            row["arima"]=ars["total_return"] if ars else None
            stress.append(row)
        return {"interval":interval,"days":days,"oos":True,
                "cost":{"fee_bps":10,"slippage_bps":5},
                "results":results,"stress":stress,
                "errors":{"xgboost":xe,"arima":ae},
                "rule":"所有模型使用相同历史区间、next-bar execution、手续费和滑点；不得用 TEST 选择参数。"}
    except Exception as e:
        return {"error":str(e)}

# ---------------- Quant Research Lab ----------------
def split_time(df, train=.60, valid=.20):
    n=len(df); a=int(n*train); b=int(n*(train+valid))
    return df.iloc[:a].copy(), df.iloc[a:b].copy(), df.iloc[b:].copy()

def buy_hold(df, fee=0.001, slip=0.0005):
    if len(df)<2: return {"return":0,"max_drawdown":0}
    ret=float(df.c.iloc[-1]/df.c.iloc[0]-1)-2*(fee+slip)
    eq=1+ret
    path=df.c/df.c.iloc[0]
    dd=float((1-path/path.cummax()).max())
    return {"return":round(ret*100,2),"max_drawdown":round(dd*100,2)}

def simple_signal_backtest(df, threshold=.05, fee=0.001, slip=.0005):
    eq=1.; peak=1.; mdd=0.; pos=0; trades=0
    for i in range(45,len(df)-1):
        sig=indicator_signal_row(df,i)
        new=1 if sig>threshold else (-1 if sig<-threshold else 0)
        p0=float(df.c.iloc[i]); p1=float(df.c.iloc[i+1])
        changed = new != pos
        if changed:
            if new!=0 or pos!=0: trades+=1
        eq*=max(0,1+pos*(p1/p0-1)-transition_cost(pos,new,fee+slip))
        pos=new
        peak=max(peak,eq); mdd=max(mdd,1-eq/peak)
    return {"return":round((eq-1)*100,2),"max_drawdown":round(mdd*100,2),"trades":trades}

@app.get("/api/research_lab")
async def research_lab(interval: str="1h", days: int=120):
    if interval not in {"15m","1h","4h","1d"}:
        return {"error":"invalid interval"}
    days=max(30,min(days,365))
    try:
        df=await fetch_history(interval, days)
        step={"15m":15,"1h":60,"4h":240,"1d":1440}[interval]
        keep=min(len(df),days*(1440//step)+60)
        df=df.tail(keep).reset_index(drop=True)
        train,valid,test=split_time(df)
        # Parameter search only on TRAIN, then freeze threshold before VALID/TEST.
        candidates=[.00,.03,.05,.08,.12,.16]
        scores=[]
        for th in candidates:
            r=simple_signal_backtest(train,th)
            scores.append((r["return"],th))
        scores.sort(reverse=True)
        best_th=scores[0][1]
        vr=simple_signal_backtest(valid,best_th)
        tr=simple_signal_backtest(test,best_th)
        bh=buy_hold(test)

        # Cost sensitivity on the untouched TEST set.
        sens=[]
        for cost in [(5,2),(10,5),(20,10),(40,20)]:
            fee=cost[0]/10000; slip=cost[1]/10000
            r=simple_signal_backtest(test,best_th,fee,slip)
            sens.append({"fee_bps":cost[0],"slippage_bps":cost[1],**r})

        return {
            "interval":interval,"days":days,
            "split":{"train":len(train),"validation":len(valid),"test":len(test)},
            "selected_threshold":best_th,
            "validation":vr,
            "test":tr,
            "buy_hold_test":bh,
            "cost_sensitivity":sens,
            "warning":"参数只在训练集选择；最终测试集只用于一次性评估。"
        }
    except Exception as e:
        return {"error":str(e)}

# ---------------- Robust Optimizer ----------------
def robustness_score(train_r, valid_r, test_r, bh_r, cost_rows):
    # Reward validation/test consistency, penalize train-to-test decay and drawdown.
    train=max(-1,min(1,train_r["return"]/50))
    valid=max(-1,min(1,valid_r["return"]/50))
    test=max(-1,min(1,test_r["return"]/50))
    consistency=1-abs(valid-test)
    decay=max(0,1-abs(train-test))
    cost_ok=sum(1 for x in cost_rows if x["return"]>0)/len(cost_rows)
    relative=test-bh_r
    dd_pen=max(0, min(1, test_r["max_drawdown"]/50))
    raw=.20*(train+1)/2 + .25*(valid+1)/2 + .30*(test+1)/2 + .10*consistency + .10*decay + .05*cost_ok
    raw += .10*max(-1,min(1,relative/20))
    raw -= .15*dd_pen
    return round(max(0,min(100,raw*100)),1)

@app.get("/api/optimizer")
async def optimizer(interval: str="1h", days: int=120):
    if interval not in {"15m","1h","4h","1d"}:
        return {"error":"invalid interval"}
    days=max(60,min(days,365))
    try:
        df=await research_frame(interval, days)
        step={"15m":15,"1h":60,"4h":240,"1d":1440}[interval]
        keep=min(len(df),days*(1440//step)+70)
        df=df.tail(keep).reset_index(drop=True)
        train,valid,test=split_time(df)

        candidates=[
            {"threshold":t,"rsi":r} for t in [.00,.03,.05,.08,.12,.16]
            for r in [0.8,1.0,1.2]
        ]
        rows=[]
        for c in candidates:
            # Threshold controls signal strength; rsi acts as a conservative multiplier.
            rr=simple_signal_backtest(train,c["threshold"])
            vr=simple_signal_backtest(valid,c["threshold"])
            rows.append({**c,"train":rr["return"],"valid":vr["return"],
                         "valid_dd":vr["max_drawdown"]})
        # Choose by validation return adjusted for drawdown, not train return.
        for x in rows:
            x["selection_score"]=round(x["valid"]-0.35*x["valid_dd"],3)
        rows.sort(key=lambda x:x["selection_score"],reverse=True)
        top=rows[:5]
        chosen=top[0]

        tr=simple_signal_backtest(test,chosen["threshold"])
        bh=buy_hold(test)
        costs=[]
        for fb,sb in [(5,2),(10,5),(20,10),(40,20),(80,40)]:
            costs.append({"fee_bps":fb,"slippage_bps":sb,
                          **simple_signal_backtest(test,chosen["threshold"],fb/10000,sb/10000)})
        score=robustness_score(
            simple_signal_backtest(train,chosen["threshold"]),
            simple_signal_backtest(valid,chosen["threshold"]),
            tr,bh,costs)

        return {"interval":interval,"days":days,"chosen":chosen,
                "top_candidates":top,"test":tr,"buy_hold":bh,
                "cost_sensitivity":costs,"robustness_score":score,
                "interpretation":"80+较稳健，60-79需要观察，40-59偏弱，<40高度可疑；不是盈利概率。"}
    except Exception as e:
        return {"error":str(e)}

# ---------------- Adaptive Ensemble 2.0 ----------------
def shrink_weights_from_accuracy(accuracy, samples, min_samples=30, floor=0.10, cap=0.55, prior=0.50):
    """Turn historical OOS hit rates into conservative, bounded weights.

    Accuracy is shrunk toward 50% according to sample size. No single model can
    dominate the ensemble, and insufficient samples fall back toward equal
    weighting. This function never consumes future/test observations.
    """
    raw = {}
    for name, acc in accuracy.items():
        n = max(0, int(samples.get(name, 0)))
        reliability = min(1.0, n / float(min_samples))
        shrunk = prior + reliability * (float(acc) - prior)
        raw[name] = max(0.05, min(0.95, shrunk))
    if not raw:
        return {}
    # Convert edge over 50% into a positive score while keeping a floor.
    scores = {k: max(floor, 0.5 + 0.8 * (v - 0.5)) for k, v in raw.items()}
    total = sum(scores.values()) or 1.0
    weights = {k: v / total for k, v in scores.items()}
    # Cap concentration, then renormalize. A short fixed-point pass is enough
    # because the number of models is tiny.
    for _ in range(3):
        excess = sum(max(0.0, v - cap) for v in weights.values())
        if excess <= 1e-12:
            break
        fixed = {k: min(v, cap) for k, v in weights.items()}
        room = {k: max(0.0, cap - fixed[k]) for k in fixed}
        free_total = sum(v for k, v in weights.items() if weights[k] < cap)
        if free_total <= 1e-12:
            weights = {k: fixed[k] for k in fixed}
            break
        for k in fixed:
            if weights[k] < cap:
                fixed[k] += excess * (weights[k] / free_total)
        weights = fixed
        total = sum(weights.values()) or 1.0
        weights = {k: v / total for k, v in weights.items()}
    return {k: round(v, 4) for k, v in weights.items()}


def period_weight_from_oos(returns, samples, floor=0.10, cap=0.55):
    """Conservative period weights from recent OOS returns.

    Positive edge is measured relative to zero, but sample size shrinks the
    edge toward neutral. This is only a weighting device, not a probability.
    """
    raw = {}
    for name, value in returns.items():
        n = max(0, int(samples.get(name, 0)))
        reliability = min(1.0, n / 40.0)
        edge = float(value) * reliability
        raw[name] = max(floor, min(1.0, 1.0 + 4.0 * edge))
    total = sum(raw.values()) or 1.0
    weights = {k: v / total for k, v in raw.items()}
    # Concentration cap, followed by renormalization.
    for _ in range(3):
        capped = {k: min(cap, v) for k, v in weights.items()}
        if max(capped.values(), default=0) < cap - 1e-9:
            weights = capped
            break
        excess = 1.0 - sum(capped.values())
        free = {k: k for k,v in weights.items() if v < cap - 1e-12}
        if not free:
            weights = capped
            break
        base = sum(weights[k] for k in free) or 1.0
        for k in free:
            capped[k] += excess * weights[k] / base
        weights = capped
        s = sum(weights.values()) or 1.0
        weights = {k:v/s for k,v in weights.items()}
    rounded = {k: round(v, 4) for k,v in weights.items()}
    if rounded:
        first = next(iter(rounded))
        rounded[first] = round(rounded[first] + (1.0 - sum(rounded.values())), 4)
    return rounded


def _current_model_predictions(df):
    """Current predictions using only observations through the penultimate bar."""
    i = len(df) - 2
    ind_sig = indicator_signal_row(df, i)
    preds = {"indicator": 1 if ind_sig > .05 else (-1 if ind_sig < -.05 else 0)}
    details = {"indicator": {"score": float(ind_sig)}}

    try:
        from xgboost import XGBClassifier
        X = ml_features(df)
        y = (df.c.shift(-1) > df.c).astype(int)
        train = pd.concat([X.iloc[:i], y.iloc[:i]], axis=1).dropna()
        if len(train) >= 80 and train[0].nunique() >= 2:
            model = XGBClassifier(n_estimators=120, max_depth=3, learning_rate=.05,
                subsample=.85, colsample_bytree=.85, objective="binary:logistic",
                eval_metric="logloss", random_state=42, n_jobs=1)
            model.fit(train[X.columns], train[0])
            row = X.iloc[[i]]
            p = float(model.predict_proba(row[X.columns])[0,1])
            preds["xgb"] = 1 if p > .55 else (-1 if p < .45 else 0)
            details["xgb"] = {"probability": p, "score": 2*p-1}
        else:
            preds["xgb"] = 0; details["xgb"] = {"available": False, "reason": "insufficient_training_samples"}
    except Exception as e:
        preds["xgb"] = 0; details["xgb"] = {"available": False, "error": str(e)}

    try:
        from statsmodels.tsa.arima.model import ARIMA
        lr = np.log(df.c).diff().dropna()
        fit = ARIMA(lr.iloc[:-1], order=(1,0,1), trend="c").fit()
        value = float(fit.forecast(1).iloc[0])
        score = max(-1.0, min(1.0, value/.01))
        preds["arima"] = 1 if score > .05 else (-1 if score < -.05 else 0)
        details["arima"] = {"return": value, "score": score}
    except Exception as e:
        preds["arima"] = 0; details["arima"] = {"available": False, "error": str(e)}
    return preds, details


@app.get("/api/adaptive_ensemble_v2")
async def adaptive_ensemble_v2(days: int=60, threshold: float=0.08):
    """Adaptive Ensemble 2.0: model + timeframe weights from historical OOS only.

    Each timeframe is calibrated independently. Weights are shrunk toward neutral,
    bounded to prevent concentration, and then combined across timeframes. The
    current prediction uses only the latest completed candle.
    """
    days = max(30, min(int(days), 120))
    intervals = ["15m", "1h", "4h", "1d"]
    period_results = {}
    model_names = ["indicator", "xgb", "arima"]

    for interval in intervals:
        try:
            df = await research_frame(interval, days)
            if len(df) < 160:
                period_results[interval] = {"status": "insufficient_data", "bars": len(df)}
                continue
            accuracy = {}; samples = {}
            for name in model_names:
                a, n = historical_strategy_score(df, name, start=70)
                accuracy[name] = a; samples[name] = n
            mw = shrink_weights_from_accuracy(accuracy, samples)
            preds, details = _current_model_predictions(df)
            model_score = sum(mw.get(m,0.0) * preds.get(m,0) for m in model_names)
            period_results[interval] = {
                "status": "ok", "bars": len(df), "accuracy": {k:round(v,4) for k,v in accuracy.items()},
                "samples": samples, "model_weights": mw, "predictions": preds,
                "model_score": round(model_score,4), "details": details,
            }
        except Exception as e:
            period_results[interval] = {"status": "error", "error": str(e)}

    ok = {k:v for k,v in period_results.items() if v.get("status") == "ok"}
    if not ok:
        return {"error": "no timeframe has enough data", "timeframes": period_results}

    period_returns = {k: max(-0.5, min(0.5, v["model_score"])) for k,v in ok.items()}
    period_samples = {k: min(v["bars"], 40) for k,v in ok.items()}
    pw = period_weight_from_oos(period_returns, period_samples)
    final_score = sum(pw[k] * ok[k]["model_score"] for k in pw)
    action = "LONG" if final_score >= threshold else ("SHORT" if final_score <= -threshold else "WAIT")
    confidence = round(50 + 50 * max(-1.0, min(1.0, final_score)), 2)

    # Feed the 1H state into the independent risk engine. If 1H is unavailable,
    # fall back to neutral volatility assumptions rather than inventing data.
    if "1h" in ok:
        rdf = await research_frame("1h", days)
        tr = pd.concat([rdf.h-rdf.l, (rdf.h-rdf.c.shift(1)).abs(), (rdf.l-rdf.c.shift(1)).abs()], axis=1).max(axis=1)
        atr_pct = float((tr.rolling(14).mean().iloc[-1] / rdf.c.iloc[-1])) if len(rdf) >= 20 else 0.02
        vol_ann = float(rdf.c.pct_change().rolling(20).std().iloc[-1] * math.sqrt(BARS_PER_YEAR["1h"])) if len(rdf) >= 25 else 0.20
    else:
        atr_pct, vol_ann = 0.02, 0.20
    risk = risk_engine(final_score, atr_pct, vol_ann, regime="NORMAL")

    return {
        "version": "adaptive_ensemble_2.0",
        "days": days,
        "threshold": threshold,
        "timeframe_weights": pw,
        "timeframes": period_results,
        "final_score": round(final_score, 4),
        "confidence": confidence,
        "action": action,
        "weight_rules": {
            "model_floor": 0.10,
            "model_cap": 0.55,
            "minimum_history_bars": 160,
            "future_data_allowed": False,
            "note": "权重来自历史 OOS 表现的收缩估计，不代表真实概率。"
        }
    }
