# Union 区块链工具

本项目是一个用于管理和执行Union跨链交易的工具集。

## 功能

1. 跨链交易执行
   - SEI <-> BABY
   - SEI <-> XION
   - BABY <-> Holesky/Sepolia

2. 水龙头自动领取
   - BABY 测试币
   - XION 测试币
   - SEI 测试币

3. 多账号批量操作
   - 支持从助记词文件批量导入
   - 多线程并行处理

4. 代理支持
   - 动态生成代理
   - 自定义代理列表

## 安装

1. 克隆项目
```bash
git clone <项目地址>
cd Union
```

2. 安装依赖
```bash
npm install
```

3. 配置环境变量
```bash
cp env.example .env
```
根据需要修改`.env`文件中的配置

## 使用方法

### 命令行工具

启动主命令行界面:
```bash
npm start
```

### 水龙头工具

启动水龙头自动领取工具:
```bash
npm run faucet
```

## 文件说明

- `cli.js` - 主命令行界面
- `crosschain-transactions.js` - 跨链交易核心功能
- `new_faucet_bbl.js` - 水龙头自动领取工具
- `config.js` - 配置文件
- `Phrase.txt` - 助记词文件（需自行创建，每行一个助记词）

## 账号管理

所有账号助记词应存储在`Phrase.txt`文件中，每行一个助记词。程序将自动从这些助记词生成相应链上的地址。

## 环境变量

主要环境变量说明:

- `PROXY_USERNAME`/`PROXY_PASSWORD`: 代理服务凭证
- `THREAD_COUNT`: 多线程数量
- `TRANSACTION_COUNT`: 每个钱包执行的交易次数
- `XXX_RPC`: 各链的RPC端点
- `XXX_BRIDGE`: 各链的桥接合约地址

详细配置请参考`env.example`文件。 