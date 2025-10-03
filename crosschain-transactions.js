// crosschain-transactions.js
// 导入必要的库
const { ethers } = require("ethers");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");
const { SigningStargateClient } = require("@cosmjs/stargate");
const { SigningCosmWasmClient } = require('@cosmjs/cosmwasm-stargate');
const { HttpsProxyAgent } = require("https-proxy-agent");
const crypto = require('crypto');
const randomUseragent = require('random-useragent');
const dotenv = require('dotenv'); // 添加dotenv依赖

// 加载环境变量
dotenv.config();

// 导入配置文件
const { OPERANDS, CONTRACTS, RPC_ENDPOINTS } = require('./config.js');

// 合约地址 (这些需要根据实际情况填写)


// 获取北京时间的函数
function getBeijingTime() {
    const now = new Date();
    const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    return beijingTime.toISOString().replace('T', ' ').substring(0, 19);
}

// 创建简单的日志对象
const logger = {
    info: (message, context = '') => {
        console.log(`[${getBeijingTime()}][INFO]${context ? ` [${context}]` : ''} ${message}`);
    },
    warn: (message, context = '') => {
        console.warn(`[${getBeijingTime()}][WARN]${context ? ` [${context}]` : ''} ${message}`);
    },
    error: (message, context = '') => {
        console.error(`[${getBeijingTime()}][ERROR]${context ? ` [${context}]` : ''} ${message}`);
    }
};

// 修改重试函数
async function retryOperation(operation, maxRetries = 3, delay = 5000, threadIndex = null, walletAddress = null) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try {
            // 添加随机延迟，避免请求过于集中
            const randomDelay = Math.floor(Math.random() * 3000) + 2000; // 2-5秒随机延迟
            await new Promise(resolve => setTimeout(resolve, randomDelay));
            return await operation();
        } catch (error) {
            lastError = error;
            // 如果是 gas 费不足，直接抛出错误
            if (error.message.includes('insufficient fees') || error.message.includes('insufficient fee')) {
                throw error;
            }
            // 如果是 429 错误，增加更长的等待时间
            if (error.message.includes('429') || error.message.includes('请求过于频繁')) {
                const backoffDelay = Math.min(2000 * Math.pow(2, i), 30000); // 指数退避，最大30秒
                const threadInfo = threadIndex !== null ? `[线程${threadIndex + 1}]` : '';
                const walletInfo = walletAddress ? `钱包 ${walletAddress}` : '';
                logger.info(`${threadInfo} ${walletInfo} 请求过于频繁，等待 ${backoffDelay / 1000} 秒后重试...`);
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
                continue;
            }
            const threadInfo = threadIndex !== null ? `[线程${threadIndex + 1}]` : '';
            const walletInfo = walletAddress ? `钱包 ${walletAddress}` : '';
            logger.info(`${threadInfo} ${walletInfo} 操作失败，${i + 1}/${maxRetries} 次重试... 错误: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
        }
    }
    throw lastError;
}

// 延迟函数
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// 获取随机用户代理
function getRandomUserAgent() {
    return randomUseragent.getRandom(ua => {
        // 过滤掉太老的浏览器
        return parseFloat(ua.browserVersion) >= 80 &&
            ['Chrome', 'Firefox', 'Edge', 'Safari'].includes(ua.browserName);
    });
}
// 添加生成代理的函数
function generateProxy() {
    // 从环境变量获取代理配置
    const USERNAME = process.env.PROXY_USERNAME;
    const PASSWORD = process.env.PROXY_PASSWORD;

    // 生成随机字符串
    const s = crypto.randomBytes(10).toString('base64').replace(/[+/=]/g, '').slice(0, 10);
    const username = USERNAME + '-residential-country_ANY-r_10m-s_' + s;
    const password = PASSWORD;
    const host = 'gate.nstproxy.io';
    const port = '24125';
    const proxyUrl = `http://${username}:${password}@${host}:${port}`;

    return {
        proxyUrl,
        proxy: {
            host,
            port: parseInt(port),
            auth: {
                username,
                password
            }
        }
    };
}

// 包查询函数
async function pollPacketHash(txHash, retries = 50, intervalMs = 5000, proxy = null, walletName = '') {
    const graphqlEndpoint = "https://graphql.union.build/v1/graphql";

    const data = { "query": "query GetPacketHashBySubmissionTxHash($submission_tx_hash: String!) {\n  v2_transfers(args: {p_transaction_hash: $submission_tx_hash}) {\n    packet_hash\n  }\n}", "variables": { "submission_tx_hash": txHash.startsWith('0x') ? txHash : `0x${txHash}` }, "operationName": "GetPacketHashBySubmissionTxHash" }

    // 初始代理
    let currentProxy = proxy;
    let proxyChangeCount = 0;
    const maxProxyChanges = 5; // 最多更换代理的次数

    for (let i = 0; i < retries; i++) {
        try {
            // 准备请求头
            const headers = {
                'accept': 'application/graphql-response+json, application/json',
                'accept-encoding': 'gzip, deflate, br, zstd',
                'accept-language': 'en-US,en;q=0.9,id;q=0.8',
                'content-type': 'application/json',
                'origin': 'https://app-union.build',
                'referer': 'https://app-union.build/',
                'user-agent': getRandomUserAgent(),
                "Content-Length": JSON.stringify(data).length
            };

            const axiosConfig = {
                headers,
                timeout: 10000
            };

            // 配置当前代理
            if (currentProxy) {
                try {
                    const proxyUrl = new URL(currentProxy);
                    axiosConfig.proxy = {
                        host: proxyUrl.hostname,
                        port: parseInt(proxyUrl.port),
                        protocol: proxyUrl.protocol.replace(':', ''),
                        auth: proxyUrl.username && proxyUrl.password ? {
                            username: proxyUrl.username,
                            password: proxyUrl.password
                        } : undefined
                    };
                    logger.info(`使用代理: ${proxyUrl.hostname}:${proxyUrl.port}`, walletName);
                } catch (e) {
                    logger.error(`代理配置错误: ${e.message}`, walletName);
                }
            }

            // 添加随机延迟，避免请求过于集中
            const randomDelay = Math.floor(Math.random() * 3000) + 2000;
            await new Promise(resolve => setTimeout(resolve, randomDelay));

            const res = await axios.post(graphqlEndpoint, data, axiosConfig);
            const result = res.data?.data?.v2_transfers;
            if (result && result.length > 0 && result[0].packet_hash) {
                return result[0].packet_hash;
            }
        } catch (e) {
            if (e.response && e.response.status === 403) {
                logger.error(`包查询被拒绝(403 Forbidden): 尝试更换代理`, walletName);

                // 遇到403错误，自动更换代理
                if (proxyChangeCount < maxProxyChanges) {
                    proxyChangeCount++;
                    // 生成新代理
                    try {
                        const newProxyInfo = generateProxy();
                        if (newProxyInfo && newProxyInfo.proxyUrl) {
                            currentProxy = newProxyInfo.proxyUrl;
                            logger.info(`已更换为新代理 (第${proxyChangeCount}次): ${currentProxy}`, walletName);
                            // 立即使用新代理重试，不等待
                            continue;
                        }
                    } catch (proxyError) {
                        logger.error(`生成新代理失败: ${proxyError.message}`, walletName);
                    }
                } else {
                    logger.warn(`已达到最大代理更换次数(${maxProxyChanges})，继续使用当前代理`, walletName);
                }
            } else if (e.code === 'ECONNABORTED') {
                logger.error(`请求超时: ${e.message}`, walletName);
            } else if (e.code === 'ECONNREFUSED') {
                logger.error(`代理连接被拒绝: ${e.message}`, walletName);
                // 连接被拒绝也尝试更换代理
                if (proxyChangeCount < maxProxyChanges) {
                    proxyChangeCount++;
                    try {
                        const newProxyInfo = generateProxy();
                        if (newProxyInfo && newProxyInfo.proxyUrl) {
                            currentProxy = newProxyInfo.proxyUrl;
                            logger.info(`连接被拒绝，已更换为新代理 (第${proxyChangeCount}次): ${currentProxy}`, walletName);
                            continue;
                        }
                    } catch (proxyError) {
                        logger.error(`生成新代理失败: ${proxyError.message}`, walletName);
                    }
                }
            } else if (e.code === 'ETIMEDOUT') {
                logger.error(`代理连接超时: ${e.message}`, walletName);
                // 连接超时也尝试更换代理
                if (proxyChangeCount < maxProxyChanges) {
                    proxyChangeCount++;
                    try {
                        const newProxyInfo = generateProxy();
                        if (newProxyInfo && newProxyInfo.proxyUrl) {
                            currentProxy = newProxyInfo.proxyUrl;
                            logger.info(`连接超时，已更换为新代理 (第${proxyChangeCount}次): ${currentProxy}`, walletName);
                            continue;
                        }
                    } catch (proxyError) {
                        logger.error(`生成新代理失败: ${proxyError.message}`, walletName);
                    }
                }
            } else if (e.code === 'EPROTO') {
                logger.error(`代理协议错误: ${e.message}`, walletName);
            } else {
                logger.error(`包查询错误: ${e.message}`, walletName);
            }
        }
        await sleep(intervalMs);
    }
    logger.warn(`在${retries}次尝试后未找到包哈希。`, walletName);
    return null;
}

// 创建代理客户端
function createProxyClient(proxy) {
    if (!proxy) return null;

    try {
        const proxyUrl = new URL(proxy);
        const axiosInstance = axios.create({
            proxy: {
                host: proxyUrl.hostname,
                port: parseInt(proxyUrl.port),
                protocol: proxyUrl.protocol.replace(':', ''),
                auth: proxyUrl.username && proxyUrl.password ? {
                    username: proxyUrl.username,
                    password: proxyUrl.password
                } : undefined
            },
            timeout: 30000,
        });

        return {
            axiosInstance,
            proxyUrl
        };
    } catch (error) {
        logger.error(`创建代理客户端失败: ${error.message}`);
        return null;
    }
}

// ===== Cosmos SDK 链相关函数 (Baby, Xion) =====

// 连接到 Cosmos SDK 链
async function connectToCosmosChain(rpcUrl, mnemonicOrPrivateKey, prefix, chainId, proxy = null) {
    try {
        let cosmosWallet;

        // 判断输入是助记词还是私钥
        if (mnemonicOrPrivateKey.includes(" ")) {
            // 输入是助记词
            logger.info(`使用助记词创建钱包`);
            cosmosWallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonicOrPrivateKey, {
                prefix: prefix,
                chainId: chainId
            });
        } else {
            // 输入是私钥
            logger.info(`使用私钥创建钱包`);
            const wallet = new ethers.Wallet(mnemonicOrPrivateKey);

            // 使用私钥的哈希作为熵
            const entropy = ethers.keccak256(ethers.concat([
                ethers.getBytes(wallet.address),
                ethers.getBytes(mnemonicOrPrivateKey)
            ]));

            // 使用熵生成助记词
            const mnemonic = ethers.Mnemonic.entropyToPhrase(entropy);

            // 使用派生的助记词创建 Cosmos 钱包
            cosmosWallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
                prefix: prefix,
                chainId: chainId
            });
        }

        // 获取账户
        const [account] = await retryOperation(async () => {
            return await cosmosWallet.getAccounts();
        }, 3, 5000);

        // 创建签名客户端
        let client;
        const proxyClient = createProxyClient(proxy);
        if (proxyClient) {
            logger.info(`使用RPC连接 ${rpcUrl}`);
            client = await SigningStargateClient.connectWithSigner(
                rpcUrl,
                cosmosWallet,
                {
                    prefix: prefix,
                    ...(proxyClient && {
                        axiosInstance: proxyClient.axiosInstance
                    })
                }
            );
        } else {
            client = await SigningStargateClient.connectWithSigner(rpcUrl, cosmosWallet);
        }

        logger.info(`已连接到 ${rpcUrl} 网络，钱包地址: ${cosmosWallet.address}`);

        return { client, wallet: cosmosWallet, account };
    } catch (error) {
        logger.error(`连接 Cosmos 链失败: ${error.message}`);
        return null;
    }
}

// 获取 Cosmos 链原生代币余额
async function getCosmosNativeBalance(rpcUrl, mnemonicOrPrivateKey, prefix, chainId, denom, proxy = null) {
    try {
        // 连接到 Cosmos 链
        const { client, account } = await connectToCosmosChain(rpcUrl, mnemonicOrPrivateKey, prefix, chainId, proxy);
        if (!client || !account) return '0';

        // 获取余额
        const balance = await retryOperation(async () => {
            return await client.getBalance(account.address, denom);
        }, 3, 5000, null, account.address);

        return balance.amount;
    } catch (error) {
        logger.error(`获取 Cosmos 余额失败: ${error.message}`);
        return '0';
    }
}

// 生成随机盐值
function generateRandomSalt(address) {
    const timestamp = Math.floor(Date.now() * 1000000); // 转换为纳秒
    const randomBytes1 = crypto.randomBytes(16).toString('hex');
    const randomBytes2 = crypto.randomBytes(16).toString('hex');
    const randomNonce = Math.floor(Math.random() * 1000000);
    const saltData = `${address}${timestamp}${randomBytes1}${randomBytes2}${randomNonce}`;
    const saltHash = crypto.createHash('sha256').update(saltData).digest('hex');
    return `0x${saltHash}`;
}

// 计算超时时间戳
function calculateTimeoutTimestamp() {
    const now = BigInt(Date.now()) * 1_000_000n;
    const oneDayNs = 86_400_000_000_000n;
    return (now + oneDayNs).toString();
}

// 估算 Gas 使用量
async function estimateGasLimit(client, senderAddress, contractAddress, msg, amount, defaultGasLimit = 600000) {
    try {
        // 模拟交易以获取 gas 估算
        const simulateResult = await client.simulate(
            senderAddress,
            [
                {
                    typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                    value: {
                        sender: senderAddress,
                        contract: contractAddress,
                        msg: Buffer.from(JSON.stringify(msg)),
                        funds: amount || []
                    }
                }
            ],
            ""
        );

        // 获取模拟结果中的 gas 使用量
        const gasUsed = simulateResult.gasInfo?.gasUsed || defaultGasLimit;

        // 增加 30% 的缓冲区以确保交易成功
        const gasLimit = Math.ceil(Number(gasUsed) * 1.3);

        logger.info(`估算 Gas: ${gasUsed}, 设置 Gas Limit: ${gasLimit} (增加 30% 缓冲)`);
        return gasLimit;
    } catch (error) {
        logger.warn(`Gas 估算失败: ${error.message}, 使用默认值: ${defaultGasLimit}`);
        return defaultGasLimit;
    }
}

// ===== 特定跨链交易函数 =====

// 从 Sei 发送到 Baby
async function transferSeiBaby(mnemonicOrPrivateKey, proxy = null, mnemonicIndex = 0) {
    try {
        logger.info(`准备从 Sei 转账到 Baby... (助记词 ${mnemonicIndex})`);
        const amount = 0.000001;
        // 连接到 Sei 链
        let seiWallet;

        // 创建provider
        let provider;
        if (proxy) {
            // 提取代理IP信息
            try {
                const proxyUrl = new URL(proxy);
                logger.info(`使用代理连接 Sei 网络: ${proxyUrl.hostname}:${proxyUrl.port} (助记词 ${mnemonicIndex})`);
            } catch (e) {
                logger.info(`使用代理连接 Sei 网络: ${proxy} (助记词 ${mnemonicIndex})`);
            }

            // 创建带有代理的 provider
            const fetchOptions = {
                agent: new HttpsProxyAgent(proxy),
                headers: {
                    'User-Agent': getRandomUserAgent()
                }
            };
            provider = new ethers.JsonRpcProvider(RPC_ENDPOINTS.sei, undefined, { fetchOptions });
        } else {
            logger.info(`不使用代理连接 Sei 网络 (助记词 ${mnemonicIndex})`);
            provider = new ethers.JsonRpcProvider(RPC_ENDPOINTS.sei);
        }

        // 判断输入是助记词还是私钥
        if (typeof mnemonicOrPrivateKey === 'string' && mnemonicOrPrivateKey.includes(" ")) {
            // 输入是助记词
            logger.info(`使用助记词创建以太坊钱包`);
            seiWallet = ethers.Wallet.fromPhrase(mnemonicOrPrivateKey, provider);
        } else {
            // 输入是私钥
            logger.info(`使用私钥创建以太坊钱包`);
            seiWallet = new ethers.Wallet(mnemonicOrPrivateKey, provider);
        }

        if (!seiWallet) return false;

        logger.info(`已连接到 Sei 网络，钱包地址: ${seiWallet.address}`);

        // 获取原生代币余额
        const balance = await retryOperation(async () => {
            return await provider.getBalance(seiWallet.address);
        }, 3, 5000, null, `${seiWallet.address} (助记词 ${mnemonicIndex})`);

        const nativeBalance = ethers.formatEther(balance);
        logger.info(`Sei 钱包余额: ${nativeBalance} SEI`);

        // 从私钥生成 Baby 地址
        // 如果是助记词，直接使用助记词派生Baby地址
        let babyAddress;
        if (typeof mnemonicOrPrivateKey === 'string' && mnemonicOrPrivateKey.includes(" ")) {
            const babyWallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonicOrPrivateKey, {
                prefix: "bbn",
                chainId: "bbn-test-5"
            });
            const [account] = await babyWallet.getAccounts();
            babyAddress = account.address;
        } else {
            // 如果是私钥，使用我们的派生函数
            babyAddress = await deriveBabyAddress();
        }

        logger.info(`派生的 Baby 地址: ${babyAddress}`);

        // 必要参数
        const channelId = 4;
        const now = BigInt(Date.now()) * 1_000_000n;
        const oneDayNs = 86_400_000_000_000n;
        const timeoutTimestamp = (now + oneDayNs).toString();
        const timestampNow = Math.floor(Date.now() / 1000);
        const timeoutHeight = 0;
        const salt = ethers.keccak256(ethers.solidityPacked(['address', 'uint256'], [seiWallet.address, timestampNow]));
        const senderHex = seiWallet.address.slice(2).toLowerCase();
        const recipientHex = Buffer.from(babyAddress, "utf8").toString("hex");

        // 创建合约实例
        const contract = new ethers.Contract(
            CONTRACTS.sei.bridge,
            CONTRACTS.sei.ABI,
            seiWallet
        );

        // 构建operand
        let operand = OPERANDS.sei_baby;
        operand = operand.replace(/senderHex/g, senderHex).replace(/recipientHex/g, recipientHex);

        // 构建指令
        const instruction = {
            version: 0,
            opcode: 2,
            operand,
        };

        // 发送交易
        logger.info("发送交易到Sei网络...");
        const tx = await retryOperation(async () => {
            return await contract.send(
                channelId,
                timeoutHeight,
                timeoutTimestamp,
                salt,
                instruction,
                { value: ethers.parseEther(amount.toString()) }
            );
        }, 3, 5000, null, `${seiWallet.address} (助记词 ${mnemonicIndex})`);

        logger.info(`交易已提交，交易哈希: ${tx.hash}`);

        // 等待交易确认
        logger.info("等待交易确认...");
        const receipt = await retryOperation(async () => {
            return await tx.wait(1);
        }, 3, 5000, null, `${seiWallet.address} (助记词 ${mnemonicIndex})`);

        // 计算消耗
        const gasUsed = receipt.gasUsed;
        const gasPrice = receipt.gasPrice || receipt.effectiveGasPrice;
        const ethCost = ethers.formatEther(gasUsed * gasPrice);
        logger.info(`Sei 到 Baby 转账消耗: ${parseFloat(ethCost) + parseFloat(amount)} SEI`);

        // 查询包哈希
        const txHash = tx.hash.startsWith('0x') ? tx.hash : `0x${tx.hash}`;
        const packetHash = await pollPacketHash(txHash, 50, 5000, proxy, `${seiWallet.address} (助记词 ${mnemonicIndex})`);
        if (packetHash) {
            logger.info(`包已提交: ${packetHash}`);
        } else {
            logger.info(`包未提交`);
        }

        logger.info(`从 Sei 转账到 Baby 成功`);
        return true;
    } catch (error) {
        logger.error(`Sei 到 Baby 转账失败: ${error.message}`);
        return false;
    }
}

// 从 Sei 发送到 Xion
async function transferSeiXion(mnemonicOrPrivateKey, proxy = null, mnemonicIndex = 0) {
    try {
        logger.info(`准备从 Sei 转账到 Xion... (助记词 ${mnemonicIndex})`);
        const amount = 0.002121799470517736;

        // 连接到 Sei 链
        let seiWallet;

        // 创建provider
        let provider;
        if (proxy) {
            // 提取代理IP信息
            try {
                const proxyUrl = new URL(proxy);
                logger.info(`使用代理连接 Sei 网络: ${proxyUrl.hostname}:${proxyUrl.port} (助记词 ${mnemonicIndex})`);
            } catch (e) {
                logger.info(`使用代理连接 Sei 网络: ${proxy} (助记词 ${mnemonicIndex})`);
            }

            // 创建带有代理的 provider
            const fetchOptions = {
                agent: new HttpsProxyAgent(proxy),
                headers: {
                    'User-Agent': getRandomUserAgent()
                }
            };
            provider = new ethers.JsonRpcProvider(RPC_ENDPOINTS.sei, undefined, { fetchOptions });
        } else {
            logger.info(`不使用代理连接 Sei 网络 (助记词 ${mnemonicIndex})`);
            provider = new ethers.JsonRpcProvider(RPC_ENDPOINTS.sei);
        }

        // 判断输入是助记词还是私钥
        if (typeof mnemonicOrPrivateKey === 'string' && mnemonicOrPrivateKey.includes(" ")) {
            // 输入是助记词
            logger.info("使用助记词创建以太坊钱包");
            seiWallet = ethers.Wallet.fromPhrase(mnemonicOrPrivateKey, provider);
        } else {
            // 输入是私钥
            logger.info(`使用私钥创建以太坊钱包`);
            seiWallet = new ethers.Wallet(mnemonicOrPrivateKey, provider);
        }

        if (!seiWallet) return false;

        logger.info(`已连接到 Sei 网络，钱包地址: ${seiWallet.address}`);

        // 获取原生代币余额
        const balance = await retryOperation(async () => {
            return await provider.getBalance(seiWallet.address);
        }, 3, 5000, null, `${seiWallet.address} (助记词 ${mnemonicIndex})`);

        const nativeBalance = ethers.formatEther(balance);
        logger.info(`Sei 钱包余额: ${nativeBalance} SEI`);

        // 从私钥生成 Xion 地址
        // 如果是助记词，直接使用助记词派生Xion地址
        let xionAddress;
        if (typeof mnemonicOrPrivateKey === 'string' && mnemonicOrPrivateKey.includes(" ")) {
            const xionWallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonicOrPrivateKey, {
                prefix: "xion",
                chainId: "xion-testnet-2"
            });
            const [account] = await xionWallet.getAccounts();
            xionAddress = account.address;
        } else {
            // 如果是私钥，使用我们的派生函数
            xionAddress = await deriveXionAddress();
        }

        logger.info(`派生的 Xion 地址: ${xionAddress}`);



        // 必要参数
        const channelId = 1; // 使用与Baby相同的通道ID
        const now = BigInt(Date.now()) * 1_000_000n;
        const oneDayNs = 86_400_000_000_000n;
        const timeoutTimestamp = (now + oneDayNs).toString();
        const timestampNow = Math.floor(Date.now() / 1000);
        const timeoutHeight = 0;
        const salt = ethers.keccak256(ethers.solidityPacked(['address', 'uint256'], [seiWallet.address, timestampNow]));
        const senderHex = seiWallet.address.slice(2).toLowerCase();
        const recipientHex = Buffer.from(xionAddress, "utf8").toString("hex");
        // console.log("salt", salt);
        // console.log("senderHex", senderHex);
        // console.log("recipientHex", recipientHex);
        // 构建operand (为Xion调整) 
        let operand = OPERANDS.sei_xion;
        operand = operand.replace(/senderHex/g, senderHex).replace(/recipientHex/g, recipientHex);
        // console.log("operand", operand);

        // 创建合约实例
        const contract = new ethers.Contract(
            CONTRACTS.sei.bridge,
            CONTRACTS.sei.ABI,
            seiWallet
        );

        // 构建指令
        const instruction = {
            version: 0,
            opcode: 2,
            operand,
        };

        // 发送交易
        logger.info("发送交易到Sei网络...");
        try {
            // 先尝试估算gas
            const gasEstimate = await retryOperation(async () => {
                return await contract.send.estimateGas(
                    channelId,
                    timeoutHeight,
                    timeoutTimestamp,
                    salt,
                    instruction,
                    { value: ethers.parseEther(amount.toString()) }
                );
            }, 3, 5000, null, `${seiWallet.address} (助记词 ${mnemonicIndex})`);

            logger.info(`估算Gas: ${gasEstimate}`);

            // 增加20%的gas限制以确保交易成功
            const gasLimit = Math.floor(Number(gasEstimate) * 1.2);

            // 发送交易
            const tx = await retryOperation(async () => {
                return await contract.send(
                    channelId,
                    timeoutHeight,
                    timeoutTimestamp,
                    salt,
                    instruction,
                    {
                        value: ethers.parseEther(amount.toString()),
                        gasLimit: gasLimit
                    }
                );
            }, 3, 5000, null, `${seiWallet.address} (助记词 ${mnemonicIndex})`);

            logger.info(`交易已提交，交易哈希: ${tx.hash}`);

            // 等待交易确认
            logger.info("等待交易确认...");
            const receipt = await retryOperation(async () => {
                return await tx.wait(1);
            }, 3, 5000, null, `${seiWallet.address} (助记词 ${mnemonicIndex})`);

            // 计算消耗
            const gasUsed = receipt.gasUsed;
            const gasPrice = receipt.gasPrice || receipt.effectiveGasPrice;
            const ethCost = ethers.formatEther(gasUsed * gasPrice);
            logger.info(`Sei 到 Xion 转账消耗: ${parseFloat(ethCost) + parseFloat(amount)} SEI`);

            // 查询包哈希
            const txHash = tx.hash.startsWith('0x') ? tx.hash : `0x${tx.hash}`;
            const packetHash = await pollPacketHash(txHash, 50, 5000, proxy, `${seiWallet.address} (助记词 ${mnemonicIndex})`);
            if (packetHash) {
                logger.info(`包已提交: ${packetHash}`);
            } else {
                logger.info(`包未提交`);
            }

            logger.info(`从 Sei 转账到 Xion 成功`);
            return true;
        } catch (txError) {
            logger.error(`交易失败: ${txError.message}`);
            return false;
        }
    } catch (error) {
        logger.error(`Sei 到 Xion 转账失败: ${error.message}`);
        return false;
    }
}

// 从sei 发送到 bnb
async function transferSeiBnb(mnemonic, proxy = null, mnemonicIndex = 0) {
    try {
        logger.info(`准备从 Sei 转账到 BNB... (助记词 ${mnemonicIndex})`);
    } catch (error) {
        logger.error(`Sei 到 BNB 转账失败: ${error.message}`);
        return false;
    }
}

// 从 Xion 发送到 Sei
async function transferXionSei(mnemonic, proxy = null, mnemonicIndex = 0) {
    try {
        logger.info(`准备从 Xion 转账到 Sei... (助记词 ${mnemonicIndex})`);
        const contractAddress = CONTRACTS.xion.bridge;
        const chainId = "xion-testnet-2";
        const prefix = "xion";

        // 连接到 Xion 链
        const connection = await connectToCosmosChain(
            RPC_ENDPOINTS.xion,
            mnemonic,
            prefix,
            chainId,
            proxy
        );

        if (!connection) {
            throw new Error("连接 Xion 链失败");
        }

        const { client, account } = connection;
        const xionAddress = account.address;
        logger.info(`发送 Xion 地址: ${xionAddress}`);

        // 从助记词生成 Sei 地址
        const ethWallet = ethers.Wallet.fromPhrase(mnemonic);
        const seiAddress = ethWallet.address;
        logger.info(`目标 Sei 地址: ${seiAddress}`);

        // 获取余额
        const balance = await retryOperation(async () => {
            return await client.getBalance(xionAddress, "uxion");
        }, 3, 5000, null, `${xionAddress} (助记词 ${mnemonicIndex})`);

        const nativeBalance = parseFloat(balance.amount) / 1_000_000;
        logger.info(`Xion 钱包余额: ${nativeBalance} XION`);

        // 必要参数
        const senderHex = Buffer.from(xionAddress, "utf8").toString("hex");
        const recipientHex = ethWallet.address.slice(2).toLowerCase();
        const salt = generateRandomSalt(xionAddress);
        const timeoutTimestamp = calculateTimeoutTimestamp();

        // 构建 operand
        let operand = OPERANDS.xion_sei;
        operand = operand.replace(/senderHex/g, senderHex).replace(/recipientHex/g, recipientHex);

        // 构造合约消息
        const msg = {
            send: {
                channel_id: 6,
                timeout_height: "0",
                timeout_timestamp: timeoutTimestamp,
                salt: salt,
                instruction: operand
            }
        };

        // 创建 CosmWasm 签名客户端
        const cosmWasmClient = await retryOperation(() => {
            // 如果有代理，在这里使用代理创建客户端
            if (proxy) {
                // 提取代理IP信息
                try {
                    const proxyUrl = new URL(proxy);
                    logger.info(`使用代理连接 Xion 网络: ${proxyUrl.hostname}:${proxyUrl.port} (助记词 ${mnemonicIndex})`);
                } catch (e) {
                    logger.info(`使用代理连接 Xion 网络: ${proxy} (助记词 ${mnemonicIndex})`);
                }

                const proxyClient = createProxyClient(proxy);
                if (proxyClient) {
                    return SigningCosmWasmClient.connectWithSigner(
                        RPC_ENDPOINTS.xion,
                        connection.wallet,
                        {
                            prefix: prefix,
                            ...(proxyClient && {
                                axiosInstance: proxyClient.axiosInstance
                            })
                        }
                    );
                }
            } else {
                logger.info(`不使用代理连接 Xion 网络 (助记词 ${mnemonicIndex})`);
            }

            // 默认不使用代理
            return SigningCosmWasmClient.connectWithSigner(
                RPC_ENDPOINTS.xion,
                connection.wallet,
                {
                    prefix: prefix
                }
            );
        },
            3,
            5000,
            null,
            xionAddress);

        if (!cosmWasmClient) {
            throw new Error("CosmWasm 签名客户端初始化失败");
        }

        // 估算 Gas
        const defaultGasLimit = 800000;
        const gasLimit = await estimateGasLimit(
            cosmWasmClient,
            xionAddress,
            contractAddress,
            msg,
            [{ denom: 'uxion', amount: "346" }],
            defaultGasLimit
        );

        const baseGasFee = Math.ceil(gasLimit * 0.0079);
        const randomMultiplier = 1.1 + Math.random() * 0.3; // 生成 1.1-1.4 之间的随机数
        const gasFee = Math.ceil(baseGasFee * randomMultiplier);
        const gasFeeInXION = (gasFee / 1000000).toFixed(6);

        logger.info(`钱包 ${xionAddress} 设置 gas limit: ${gasLimit}, gas fee: ${gasFeeInXION} XION (随机倍数: ${randomMultiplier.toFixed(2)})`);

        if (parseInt(balance.amount) < gasFee) {
            logger.info(`钱包 ${xionAddress} 余额不足，当前余额: ${nativeBalance} XION, 需要gas: ${gasFeeInXION} XION，退出线程`);
            return false;
        }

        // 发送交易
        logger.info("发送交易到Xion网络...");
        const result = await retryOperation(async () => {
            return await cosmWasmClient.execute(
                account.address,
                contractAddress,
                msg,
                { amount: [{ denom: 'uxion', amount: gasFee.toString() }], gas: gasLimit.toString() },
                undefined,
                [{ denom: 'uxion', amount: '346' }]
            );
        }, 3, 5000, null, `${xionAddress} (助记词 ${mnemonicIndex})`);

        logger.info(`交易已提交，交易哈希: ${result.transactionHash}`);

        // 等待交易确认
        const receipt = await retryOperation(async () => {
            return await cosmWasmClient.getTx(result.transactionHash);
        }, 3, 5000, null, `${xionAddress} (助记词 ${mnemonicIndex})`);

        if (receipt && receipt.height > 0) {
            logger.info(`交易已确认，区块高度: ${receipt.height}`);
            logger.info(`浏览器: https://explorer.burnt.com/xion-testnet-2/tx/${result.transactionHash}`);
            logger.info(`从 Xion 转账到 Sei 成功`);
            // 查询包哈希
            const txHash = result.transactionHash.startsWith('0x') ? result.transactionHash : `0x${result.transactionHash}`;
            const packetHash = await pollPacketHash(txHash, 50, 5000, proxy, `${xionAddress} (助记词 ${mnemonicIndex})`);
            if (packetHash) {
                logger.info(`包已提交: ${packetHash}`);
            } else {
                logger.info(`包未提交`);
            }
            return true;
        } else {
            throw new Error("交易未确认");
        }
    } catch (error) {
        logger.error(`Xion 到 Sei 转账失败: ${error.message}`);
        return false;
    }
}

// 从 Baby 发送到 Holesky
async function transferBabyHolesky(mnemonic, proxy = null, mnemonicIndex = 0) {
    try {
        logger.info(`准备从 Baby 转账到 Holesky... (助记词 ${mnemonicIndex})`);
        const contractAddress = CONTRACTS.baby.bridge;
        const chainId = "bbn-test-5";
        const prefix = "bbn";

        // 连接到 Baby 链
        const connection = await connectToCosmosChain(
            RPC_ENDPOINTS.baby,
            mnemonic,
            prefix,
            chainId,
            proxy
        );

        if (!connection) {
            throw new Error("连接 Baby 链失败");
        }

        const { client, account } = connection;
        const bbnAddress = account.address;
        logger.info(`发送 Baby 地址: ${bbnAddress}`);

        // 从助记词生成 Holesky 地址
        const ethWallet = ethers.Wallet.fromPhrase(mnemonic);
        const holeskyAddress = ethWallet.address;
        logger.info(`目标 Holesky 地址: ${holeskyAddress}`);

        // 获取余额
        const balance = await retryOperation(async () => {
            return await client.getBalance(bbnAddress, "ubbn");
        }, 3, 5000, null, `${bbnAddress} (助记词 ${mnemonicIndex})`);

        const nativeBalance = parseFloat(balance.amount) / 1_000_000;
        logger.info(`Baby 钱包余额: ${nativeBalance} BBN`);

        // 必要参数
        const senderHex = Buffer.from(bbnAddress, "utf8").toString("hex");
        const recipientHex = ethWallet.address.slice(2).toLowerCase();
        const salt = generateRandomSalt(bbnAddress);
        const timeoutTimestamp = calculateTimeoutTimestamp();

        // 构建 operand
        let instruction = OPERANDS.baby_holesky;
        instruction = instruction.replace(/senderHex/g, senderHex).replace(/recipientHex/g, recipientHex);

        // 构造合约消息
        const msg = {
            send: {
                channel_id: 2,
                timeout_height: "0",
                timeout_timestamp: timeoutTimestamp,
                salt: salt,
                instruction: instruction
            }
        };

        // 创建 CosmWasm 签名客户端
        const cosmWasmClient = await retryOperation(() => {
            // 如果有代理，在这里使用代理创建客户端
            if (proxy) {
                // 提取代理IP信息
                try {
                    const proxyUrl = new URL(proxy);
                    logger.info(`使用代理连接 Baby 网络: ${proxyUrl.hostname}:${proxyUrl.port} (助记词 ${mnemonicIndex})`);
                } catch (e) {
                    logger.info(`使用代理连接 Baby 网络: ${proxy} (助记词 ${mnemonicIndex})`);
                }

                const proxyClient = createProxyClient(proxy);
                if (proxyClient) {
                    return SigningCosmWasmClient.connectWithSigner(
                        RPC_ENDPOINTS.baby,
                        connection.wallet,
                        {
                            prefix: prefix,
                            ...(proxyClient && {
                                axiosInstance: proxyClient.axiosInstance
                            })
                        }
                    );
                }
            } else {
                logger.info(`不使用代理连接 Baby 网络 (助记词 ${mnemonicIndex})`);
            }

            // 默认不使用代理
            return SigningCosmWasmClient.connectWithSigner(
                RPC_ENDPOINTS.baby,
                connection.wallet,
                {
                    prefix: prefix
                }
            );
        },
            3,
            5000,
            null,
            bbnAddress);

        if (!cosmWasmClient) {
            throw new Error("CosmWasm 签名客户端初始化失败");
        }

        // 估算 Gas
        const defaultGasLimit = 600000;
        const gasLimit = await estimateGasLimit(
            cosmWasmClient,
            bbnAddress,
            contractAddress,
            msg,
            [{ denom: 'ubbn', amount: "59285" }],
            defaultGasLimit
        );

        const baseGasFee = Math.ceil(gasLimit * 0.0079);
        const randomMultiplier = 1.1 + Math.random() * 0.3; // 生成 1.1-1.4 之间的随机数
        const gasFee = Math.ceil(baseGasFee * randomMultiplier);
        const gasFeeInBBN = (gasFee / 1000000).toFixed(6);

        logger.info(`钱包 ${bbnAddress} 设置 gas limit: ${gasLimit}, gas fee: ${gasFeeInBBN} BBN (随机倍数: ${randomMultiplier.toFixed(2)})`);

        if (parseInt(balance.amount) < gasFee) {
            logger.info(`钱包 ${bbnAddress} 余额不足，当前余额: ${nativeBalance} BBN, 需要gas: ${gasFeeInBBN} BBN，退出线程`);
            return false;
        }

        // 执行交易
        const result = await retryOperation(async () => {
            const tx = await cosmWasmClient.execute(
                bbnAddress,
                contractAddress,
                msg,
                { amount: [{ denom: 'ubbn', amount: gasFee.toString() }], gas: gasLimit.toString() },
                null,
                [{ denom: 'ubbn', amount: "93913" }]
            );
            return tx;
        }, 3, 5000, null, `${bbnAddress} (助记词 ${mnemonicIndex})`);

        // 等待交易确认
        const tx = await retryOperation(async () => {
            return await cosmWasmClient.getTx(result.transactionHash);
        }, 3, 5000, null, `${bbnAddress} (助记词 ${mnemonicIndex})`);

        if (tx && tx.height > 0) {
            logger.info(`交易已确认，区块高度: ${tx.height}`);
            logger.info(`浏览器: https://babylon-testnet.l2scan.co/tx/${result.transactionHash}`);
            logger.info(`从 Baby 转账到 Holesky 成功`);
            // 查询包哈希
            const txHash = result.transactionHash.startsWith('0x') ? result.transactionHash : `0x${result.transactionHash}`;
            const packetHash = await pollPacketHash(txHash, 50, 5000, proxy, `${bbnAddress} (助记词 ${mnemonicIndex})`);
            if (packetHash) {
                logger.info(`包已提交: ${packetHash}`);
            } else {
                logger.info(`包未提交`);
            }
            return true;
        } else {
            throw new Error("交易未确认");
        }
    } catch (error) {
        logger.error(`Baby 到 Holesky 转账失败: ${error.message}`);
        return false;
    }
}

// 从 Baby 发送到 Sepolia
async function transferBabySepolia(mnemonic, proxy = null, mnemonicIndex = 0) {
    try {
        logger.info(`准备从 Baby 转账到 Sepolia... (助记词 ${mnemonicIndex})`);
        const contractAddress = CONTRACTS.baby.bridge;
        const chainId = "bbn-test-5";
        const prefix = "bbn";

        // 连接到 Baby 链
        const connection = await connectToCosmosChain(
            RPC_ENDPOINTS.baby,
            mnemonic,
            prefix,
            chainId,
            proxy
        );

        if (!connection) {
            throw new Error("连接 Baby 链失败");
        }

        const { client, account } = connection;
        const bbnAddress = account.address;
        logger.info(`发送 Baby 地址: ${bbnAddress}`);

        // 从助记词生成 Sepolia 地址
        const ethWallet = ethers.Wallet.fromPhrase(mnemonic);
        const sepoliaAddress = ethWallet.address;
        logger.info(`目标 Sepolia 地址: ${sepoliaAddress}`);

        // 获取余额
        const balance = await retryOperation(async () => {
            return await client.getBalance(bbnAddress, "ubbn");
        }, 3, 5000, null, `${bbnAddress} (助记词 ${mnemonicIndex})`);

        const nativeBalance = parseFloat(balance.amount) / 1_000_000;
        logger.info(`Baby 钱包余额: ${nativeBalance} BBN`);

        // 必要参数
        const senderHex = Buffer.from(bbnAddress, "utf8").toString("hex");
        const recipientHex = ethWallet.address.slice(2).toLowerCase();
        const salt = generateRandomSalt(bbnAddress);
        const timeoutTimestamp = calculateTimeoutTimestamp();

        // 构建 operand
        let instruction = OPERANDS.baby_sepolia;
        instruction = instruction.replace(/senderHex/g, senderHex).replace(/recipientHex/g, recipientHex);

        // 构造合约消息
        const msg = {
            send: {
                channel_id: 1,
                timeout_height: "0",
                timeout_timestamp: timeoutTimestamp,
                salt: salt,
                instruction: instruction
            }
        };

        // 创建 CosmWasm 签名客户端
        const cosmWasmClient = await retryOperation(() => {
            // 如果有代理，在这里使用代理创建客户端
            if (proxy) {
                // 提取代理IP信息
                try {
                    const proxyUrl = new URL(proxy);
                    logger.info(`使用代理连接 Baby 网络: ${proxyUrl.hostname}:${proxyUrl.port} (助记词 ${mnemonicIndex})`);
                } catch (e) {
                    logger.info(`使用代理连接 Baby 网络: ${proxy} (助记词 ${mnemonicIndex})`);
                }
                const proxyClient = createProxyClient(proxy);
                if (proxyClient) {
                    return SigningCosmWasmClient.connectWithSigner(
                        RPC_ENDPOINTS.baby,
                        connection.wallet,
                        {
                            prefix: prefix,
                            ...(proxyClient && {
                                axiosInstance: proxyClient.axiosInstance
                            })
                        }
                    );
                }
            } else {
                logger.info(`不使用代理连接 Baby 网络 (助记词 ${mnemonicIndex})`);
            }

            // 默认不使用代理
            return SigningCosmWasmClient.connectWithSigner(
                RPC_ENDPOINTS.baby,
                connection.wallet,
                {
                    prefix: prefix
                }
            );
        },
            3,
            5000,
            null,
            bbnAddress);

        if (!cosmWasmClient) {
            throw new Error("CosmWasm 签名客户端初始化失败");
        }

        // 估算 Gas
        const defaultGasLimit = 600000;
        const gasLimit = await estimateGasLimit(
            cosmWasmClient,
            bbnAddress,
            contractAddress,
            msg,
            [{ denom: 'ubbn', amount: "93913" }],
            defaultGasLimit
        );

        const baseGasFee = Math.ceil(gasLimit * 0.0079);
        const randomMultiplier = 1.1 + Math.random() * 0.3; // 生成 1.1-1.4 之间的随机数
        const gasFee = Math.ceil(baseGasFee * randomMultiplier);
        const gasFeeInBBN = (gasFee / 1000000).toFixed(6);

        logger.info(`钱包 ${bbnAddress} 设置 gas limit: ${gasLimit}, gas fee: ${gasFeeInBBN} BBN (随机倍数: ${randomMultiplier.toFixed(2)})`);

        if (parseInt(balance.amount) < gasFee) {
            logger.info(`钱包 ${bbnAddress} 余额不足，当前余额: ${nativeBalance} BBN, 需要gas: ${gasFeeInBBN} BBN，退出线程`);
            return false;
        }

        // 执行交易
        const result = await retryOperation(async () => {
            const tx = await cosmWasmClient.execute(
                bbnAddress,
                contractAddress,
                msg,
                { amount: [{ denom: 'ubbn', amount: gasFee.toString() }], gas: gasLimit.toString() },
                null,
                [{ denom: 'ubbn', amount: "99761" }]
            );
            return tx;
        }, 3, 5000, null, `${bbnAddress} (助记词 ${mnemonicIndex})`);

        // 等待交易确认
        const tx = await retryOperation(async () => {
            return await cosmWasmClient.getTx(result.transactionHash);
        }, 3, 5000, null, `${bbnAddress} (助记词 ${mnemonicIndex})`);

        if (tx && tx.height > 0) {
            logger.info(`交易已确认，区块高度: ${tx.height}`);
            logger.info(`浏览器: https://babylon-testnet.l2scan.co/tx/${result.transactionHash}`);
            logger.info(`从 Baby 转账到 Sepolia 成功`);
            // 查询包哈希
            const txHash = result.transactionHash.startsWith('0x') ? result.transactionHash : `0x${result.transactionHash}`;
            const packetHash = await pollPacketHash(txHash, 50, 5000, proxy, `${bbnAddress} (助记词 ${mnemonicIndex})`);
            if (packetHash) {
                logger.info(`包已提交: ${packetHash}`);
            } else {
                logger.info(`包未提交`);
            }
            return true;
        } else {
            throw new Error("交易未确认");
        }
    } catch (error) {
        logger.error(`Baby 到 Sepolia 转账失败: ${error.message}`);
        return false;
    }
}

// 从 Baby 发送到 BNB
async function transferBabyBNB(mnemonic, proxy = null, mnemonicIndex = 0) {
    try {
        logger.info(`准备从 Baby 转账到 BNB... (助记词 ${mnemonicIndex})`);
        const contractAddress = CONTRACTS.baby.bridge;
        const chainId = "bbn-test-5";
        const prefix = "bbn";

        // 连接到 Baby 链
        const connection = await connectToCosmosChain(
            RPC_ENDPOINTS.baby,
            mnemonic,
            prefix,
            chainId,
            proxy
        );

        if (!connection) {
            throw new Error("连接 Baby 链失败");
        }

        const { client, account } = connection;
        const bbnAddress = account.address;
        logger.info(`发送 Baby 地址: ${bbnAddress}`);

        // 从助记词生成 BNB 地址
        const ethWallet = ethers.Wallet.fromPhrase(mnemonic);
        const bnbAddress = ethWallet.address;
        logger.info(`目标 BNB 地址: ${bnbAddress}`);

        // 获取余额
        const balance = await retryOperation(async () => {
            return await client.getBalance(bbnAddress, "ubbn");
        }, 3, 5000, null, `${bbnAddress} (助记词 ${mnemonicIndex})`);

        const nativeBalance = parseFloat(balance.amount) / 1_000_000;
        logger.info(`Baby 钱包余额: ${nativeBalance} BBN`);

        // 必要参数
        const senderHex = Buffer.from(bbnAddress, "utf8").toString("hex");
        const recipientHex = ethWallet.address.slice(2).toLowerCase();
        const salt = generateRandomSalt(bbnAddress);
        const timeoutTimestamp = calculateTimeoutTimestamp();

        // 构建 operand
        let instruction = OPERANDS.baby_bnb;
        instruction = instruction.replace(/senderHex/g, senderHex).replace(/recipientHex/g, recipientHex);

        // 构造合约消息
        const msg = {
            send: {
                channel_id: 7,
                timeout_height: "0",
                timeout_timestamp: timeoutTimestamp,
                salt: salt,
                instruction: instruction
            }
        };

        // 创建 CosmWasm 签名客户端
        const cosmWasmClient = await retryOperation(() => {
            // 如果有代理，在这里使用代理创建客户端
            if (proxy) {
                // 提取代理IP信息
                try {
                    const proxyUrl = new URL(proxy);
                    logger.info(`使用代理连接 Baby 网络: ${proxyUrl.hostname}:${proxyUrl.port} (助记词 ${mnemonicIndex})`);
                } catch (e) {
                    logger.info(`使用代理连接 Baby 网络: ${proxy} (助记词 ${mnemonicIndex})`);
                }
                const proxyClient = createProxyClient(proxy);
                if (proxyClient) {
                    return SigningCosmWasmClient.connectWithSigner(
                        RPC_ENDPOINTS.baby,
                        connection.wallet,
                        {
                            prefix: prefix,
                            ...(proxyClient && {
                                axiosInstance: proxyClient.axiosInstance
                            })
                        }
                    );
                }
            } else {
                logger.info(`不使用代理连接 Baby 网络 (助记词 ${mnemonicIndex})`);
            }

            // 默认不使用代理
            return SigningCosmWasmClient.connectWithSigner(
                RPC_ENDPOINTS.baby,
                connection.wallet,
                {
                    prefix: prefix
                }
            );
        },
            3,
            5000,
            null,
            bbnAddress);

        if (!cosmWasmClient) {
            throw new Error("CosmWasm 签名客户端初始化失败");
        }

        // 估算 Gas
        const defaultGasLimit = 600000;
        const gasLimit = await estimateGasLimit(
            cosmWasmClient,
            bbnAddress,
            contractAddress,
            msg,
            [{ denom: 'ubbn', amount: "1261745" }],
            defaultGasLimit
        );

        const baseGasFee = Math.ceil(gasLimit * 0.0079);
        const randomMultiplier = 1.1 + Math.random() * 0.3; // 生成 1.1-1.4 之间的随机数
        const gasFee = Math.ceil(baseGasFee * randomMultiplier);
        const gasFeeInBBN = (gasFee / 1000000).toFixed(6);

        logger.info(`钱包 ${bbnAddress} 设置 gas limit: ${gasLimit}, gas fee: ${gasFeeInBBN} BBN (随机倍数: ${randomMultiplier.toFixed(2)})`);

        if (parseInt(balance.amount) < gasFee) {
            logger.info(`钱包 ${bbnAddress} 余额不足，当前余额: ${nativeBalance} BBN, 需要gas: ${gasFeeInBBN} BBN，退出线程`);
            return false;
        }

        // 执行交易
        const result = await retryOperation(async () => {
            const tx = await cosmWasmClient.execute(
                bbnAddress,
                contractAddress,
                msg,
                { amount: [{ denom: 'ubbn', amount: gasFee.toString() }], gas: gasLimit.toString() },
                null,
                [{ denom: 'ubbn', amount: "1261745" }]
            );
            return tx;
        }, 3, 5000, null, `${bbnAddress} (助记词 ${mnemonicIndex})`);

        // 等待交易确认
        const tx = await retryOperation(async () => {
            return await cosmWasmClient.getTx(result.transactionHash);
        }, 3, 5000, null, `${bbnAddress} (助记词 ${mnemonicIndex})`);

        if (tx && tx.height > 0) {
            logger.info(`交易已确认，区块高度: ${tx.height}`);
            logger.info(`浏览器: https://babylon-testnet.l2scan.co/tx/${result.transactionHash}`);
            logger.info(`从 Baby 转账到 Sepolia 成功`);
            // 查询包哈希
            const txHash = result.transactionHash.startsWith('0x') ? result.transactionHash : `0x${result.transactionHash}`;
            const packetHash = await pollPacketHash(txHash, 50, 5000, proxy, `${bbnAddress} (助记词 ${mnemonicIndex})`);
            if (packetHash) {
                logger.info(`包已提交: ${packetHash}`);
            } else {
                logger.info(`包未提交`);
            }
            return true;
        } else {
            throw new Error("交易未确认");
        }
    } catch (error) {
        logger.error(`Baby 到 Sepolia 转账失败: ${error.message}`);
        return false;
    }
}

// 从 Baby 发送到 osmo
async function transferBabyOsmo(mnemonic, proxy = null, mnemonicIndex = 0) {
    try {
        logger.info(`准备从 Baby 转账到 osmo... (助记词 ${mnemonicIndex})`);
        const contractAddress = CONTRACTS.baby.bridge;
        const chainId = "bbn-test-5";
        const prefix = "bbn";

        // 连接到 Baby 链
        const connection = await connectToCosmosChain(
            RPC_ENDPOINTS.baby,
            mnemonic,
            prefix,
            chainId,
            proxy
        );

        if (!connection) {
            throw new Error("连接 Baby 链失败");
        }

        const { client, account } = connection;
        const bbnAddress = account.address;
        logger.info(`发送 Baby 地址: ${bbnAddress}`);

        // 从助记词派生 osmo 地址
        const osmoAddress = await deriveOsmoAddress(mnemonic);
        logger.info(`目标 osmo 地址: ${osmoAddress}`);

        // 获取余额
        const balance = await retryOperation(async () => {
            return await client.getBalance(bbnAddress, "ubbn");
        }, 3, 5000, null, `${bbnAddress} (助记词 ${mnemonicIndex})`);

        const nativeBalance = parseFloat(balance.amount) / 1_000_000;
        logger.info(`Baby 钱包余额: ${nativeBalance} BBN`);

        // 必要参数
        const senderHex = Buffer.from(bbnAddress, "utf8").toString("hex");
        const recipientHex = Buffer.from(osmoAddress, "utf8").toString("hex");
        const salt = generateRandomSalt(bbnAddress);
        const timeoutTimestamp = calculateTimeoutTimestamp();

        // 构建 operand
        let instruction = OPERANDS.baby_osmo;
        instruction = instruction.replace(/senderHex/g, senderHex).replace(/recipientHex/g, recipientHex);

        // 构造合约消息
        const msg = {
            send: {
                channel_id: 5,
                timeout_height: "0",
                timeout_timestamp: timeoutTimestamp,
                salt: salt,
                instruction: instruction
            }
        };

        // 创建 CosmWasm 签名客户端
        const cosmWasmClient = await retryOperation(() => {
            // 如果有代理，在这里使用代理创建客户端
            if (proxy) {
                // 提取代理IP信息
                try {
                    const proxyUrl = new URL(proxy);
                    logger.info(`使用代理连接 Baby 网络: ${proxyUrl.hostname}:${proxyUrl.port} (助记词 ${mnemonicIndex})`);
                } catch (e) {
                    logger.info(`使用代理连接 Baby 网络: ${proxy} (助记词 ${mnemonicIndex})`);
                }
                const proxyClient = createProxyClient(proxy);
                if (proxyClient) {
                    return SigningCosmWasmClient.connectWithSigner(
                        RPC_ENDPOINTS.baby,
                        connection.wallet,
                        {
                            prefix: prefix,
                            ...(proxyClient && {
                                axiosInstance: proxyClient.axiosInstance
                            })
                        }
                    );
                }
            } else {
                logger.info(`不使用代理连接 Baby 网络 (助记词 ${mnemonicIndex})`);
            }

            // 默认不使用代理
            return SigningCosmWasmClient.connectWithSigner(
                RPC_ENDPOINTS.baby,
                connection.wallet,
                {
                    prefix: prefix
                }
            );
        },
            3,
            5000,
            null,
            bbnAddress);

        if (!cosmWasmClient) {
            throw new Error("CosmWasm 签名客户端初始化失败");
        }

        // 估算 Gas
        const defaultGasLimit = 600000;
        const gasLimit = await estimateGasLimit(
            cosmWasmClient,
            bbnAddress,
            contractAddress,
            msg,
            [{ denom: 'ubbn', amount: "175412" }],
            defaultGasLimit
        );

        const baseGasFee = Math.ceil(gasLimit * 0.0079);
        const randomMultiplier = 1.1 + Math.random() * 0.3; // 生成 1.1-1.4 之间的随机数
        const gasFee = Math.ceil(baseGasFee * randomMultiplier);
        const gasFeeInBBN = (gasFee / 1000000).toFixed(6);

        logger.info(`钱包 ${bbnAddress} 设置 gas limit: ${gasLimit}, gas fee: ${gasFeeInBBN} BBN (随机倍数: ${randomMultiplier.toFixed(2)})`);

        if (parseInt(balance.amount) < gasFee) {
            logger.info(`钱包 ${bbnAddress} 余额不足，当前余额: ${nativeBalance} BBN, 需要gas: ${gasFeeInBBN} BBN，退出线程`);
            return false;
        }

        // 执行交易
        const result = await retryOperation(async () => {
            const tx = await cosmWasmClient.execute(
                bbnAddress,
                contractAddress,
                msg,
                { amount: [{ denom: 'ubbn', amount: gasFee.toString() }], gas: gasLimit.toString() },
                null,
                [{ denom: 'ubbn', amount: "175412" }]
            );
            return tx;
        }, 3, 5000, null, `${bbnAddress} (助记词 ${mnemonicIndex})`);

        // 等待交易确认
        const tx = await retryOperation(async () => {
            return await cosmWasmClient.getTx(result.transactionHash);
        }, 3, 5000, null, `${bbnAddress} (助记词 ${mnemonicIndex})`);

        if (tx && tx.height > 0) {
            logger.info(`交易已确认，区块高度: ${tx.height}`);
            logger.info(`浏览器: https://babylon-testnet.l2scan.co/tx/${result.transactionHash}`);
            logger.info(`从 Baby 转账到 Sepolia 成功`);
            // 查询包哈希
            const txHash = result.transactionHash.startsWith('0x') ? result.transactionHash : `0x${result.transactionHash}`;
            const packetHash = await pollPacketHash(txHash, 50, 5000, proxy, `${bbnAddress} (助记词 ${mnemonicIndex})`);
            if (packetHash) {
                logger.info(`包已提交: ${packetHash}`);
            } else {
                logger.info(`包未提交`);
            }
            return true;
        } else {
            throw new Error("交易未确认");
        }
    } catch (error) {
        logger.error(`Baby 到 Sepolia 转账失败: ${error.message}`);
        return false;
    }
}

// 从Phrase.txt读取助记词
function loadMnemonic() {
    try {
        const mnemonicPath = path.join(__dirname, 'Phrase.txt');
        const mnemonic = fs.readFileSync(mnemonicPath, 'utf8').trim();
        return mnemonic;
    } catch (error) {
        logger.error(`读取助记词失败: ${error.message}`);
        throw new Error("无法读取助记词文件");
    }
}

// 从助记词派生 Baby 地址
async function deriveBabyAddress(mnemonic) {
    try {
        // 使用助记词创建 Baby 钱包
        const babyWallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
            prefix: "bbn",
            chainId: "bbn-test-5"
        });

        const [account] = await babyWallet.getAccounts();
        return account.address;
    } catch (error) {
        logger.error(`从助记词派生 Baby 地址失败: ${error.message}`);
        throw new Error("无法派生 Baby 地址");
    }
}

// 从助记词派生 osmo 地址
async function deriveOsmoAddress(mnemonic) {
    try {
        // 使用助记词创建 osmo 钱包
        const osmoWallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
            prefix: "osmo",
            chainId: "osmo-test-5"
        });

        const [account] = await osmoWallet.getAccounts();
        return account.address;
    } catch (error) {
        logger.error(`从助记词派生 osmo 地址失败: ${error.message}`);
        throw new Error("无法派生 osmo 地址");
    }
}

async function deriveXionAddress(mnemonic) {
    try {
        // 使用助记词而不是私钥

        // 使用助记词创建 Xion 钱包
        const xionWallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
            prefix: "xion",
            chainId: "xion-testnet-2"
        });

        const [account] = await xionWallet.getAccounts();
        return account.address;
    } catch (error) {
        logger.error(`从助记词派生 Xion 地址失败: ${error.message}`);
        throw new Error("无法派生 Xion 地址");
    }
}

// 模块导出
module.exports = {
    // 地址派生函数
    deriveBabyAddress,
    deriveXionAddress,
    deriveOsmoAddress,
    // 转账函数
    transferSeiBaby,
    transferSeiXion,
    transferBabyHolesky,
    transferBabySepolia,
    transferXionSei,
    transferBabyBNB,
    transferBabyOsmo,

    // 工具函数
    getCosmosNativeBalance,
    connectToCosmosChain,
    estimateGasLimit,
    generateRandomSalt,
    calculateTimeoutTimestamp,
    createProxyClient,
    retryOperation,
    sleep,
    pollPacketHash,
    getRandomUserAgent,
    loadMnemonic
};