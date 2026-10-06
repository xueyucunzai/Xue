# QuantVote — GitHub Upload Edition

这是 QuantVote 的“单层仓库”部署版，专门适配手机/平板上传 GitHub：
**解压后所有主要文件都在最外层，不需要上传文件夹。**

## 目录结构

```text
QuantVote/
├── main.py              # Python / FastAPI 量化引擎
├── index.html            # 前端页面
├── app.js                # 前端逻辑
├── style.css             # 前端样式
├── worker.js             # Cloudflare Worker API 代理
├── wrangler.toml         # Worker 配置
├── package.json          # Wrangler/Node 配置
├── requirements.txt      # Python 依赖
├── render.yaml           # Render 部署配置
├── Dockerfile            # 可选容器部署
├── test_core.py          # 核心测试
├── wire_cloudflare.sh    # 可选自动连线脚本
├── .gitignore
└── .dockerignore
```

## 手机/平板上传 GitHub

1. 解压本 ZIP。
2. GitHub 新建一个空仓库。
3. 打开仓库的 **Add file → Upload files**。
4. 进入解压后的文件列表，**全选第一层文件**上传。
5. 不需要手动创建 `backend`、`frontend`、`worker` 文件夹。

> 如果手机 GitHub App 不支持一次选择全部文件，就按批次上传即可；所有文件都应该最终位于仓库根目录。

## 部署结构

```text
Cloudflare Pages（index.html / app.js / style.css）
              │
              ▼
Cloudflare Worker（worker.js）
              │
              ▼
Render Python Engine（main.py）
              │
              ▼
Binance Public API
```

## Render

Render 从 GitHub 仓库读取 `render.yaml`，启动命令已经改成：

```text
uvicorn main:app --host 0.0.0.0 --port $PORT
```

健康检查：

```text
/api/health
```

## Cloudflare Worker

Worker 的入口已经改成根目录：

```text
worker.js
```

不要把 Render 地址写进 GitHub 文件。部署 Worker 后设置 Secret：

```text
QUANT_ENGINE_URL=https://你的-render-服务.onrender.com
```

## 前端

前端默认使用同源 `/api`，因此部署到 Cloudflare Pages 后无需修改代码。
本地调试可以通过浏览器环境变量方式覆盖 API 地址（当前代码使用 `window.QV_API`）。

## 研究边界

这是研究/回测系统，不是自动交易系统。

- 信号与执行遵守 next-bar 规则。
- 成本进入回测。
- Walk-forward / OOS 研究保持时间顺序。
- 自适应权重不能使用未来数据。
- 公网部署成功不代表获得真实 BTC Alpha。
