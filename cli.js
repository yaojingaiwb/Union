// cli.js - 命令行界面
const readline = require('readline');
const fs = require('fs');
const crosschainTransactions = require('./crosschain-transactions');
const crypto = require('crypto'); // 用于生成随机代理
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads'); // 用于多线程
const cron = require('node-cron'); // 用于定时任务
const dotenv = require('dotenv'); // 添加dotenv依赖

// 加载.env文件
dotenv.config();

// 获取北京时间的函数
function getBeijingTime() {
    const now = new Date();
    const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    return beijingTime.toISOString().replace('T', ' ').substring(0, 19);
}

// 创建 readline 接口
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// 全局变量，从环境变量读取
let USERNAME = process.env.PROXY_USERNAME; // 代理通道id，从环境变量读取，有默认值
let PASSWORD = process.env.PROXY_PASSWORD; // 代理密码，从环境变量读取，有默认值
let useProxy = process.env.USE_PROXY === "false" ? false : true; // 是否使用代理，默认为true
let customProxies = []; // 自定义代理列表
let useCustomProxies = process.env.USE_CUSTOM_PROXIES === "true" ? true : false; // 是否使用自定义代理，默认为false
let transactionCount = parseInt(process.env.TRANSACTION_COUNT) || 1; // 每个钱包执行的交易次数
let threadCount = parseInt(process.env.THREAD_COUNT) || 1; // 线程数量
let autoRunEnabled = process.env.AUTO_RUN_ENABLED === "true" ? true : false; // 是否启用自动运行

// 如果配置了代理文件路径且启用了自定义代理，则尝试加载
if (process.env.PROXY_FILE && useCustomProxies) {
    loadProxiesFromFile(process.env.PROXY_FILE).catch(error => {
        console.error(`[${getBeijingTime()}] 加载代理文件失败: ${error.message}`);
    });
}

// 生成代理地址
function generateProxy() {
    // 如果使用自定义代理列表且列表不为空
    if (useCustomProxies && customProxies.length > 0) {
        // 随机选择一个代理
        const randomIndex = Math.floor(Math.random() * customProxies.length);
        const proxyUrl = customProxies[randomIndex];

        try {
            const proxyUrlObj = new URL(proxyUrl);
            return {
                proxyUrl,
                proxy: {
                    host: proxyUrlObj.hostname,
                    port: parseInt(proxyUrlObj.port),
                    auth: proxyUrlObj.username && proxyUrlObj.password ? {
                        username: proxyUrlObj.username,
                        password: proxyUrlObj.password
                    } : undefined
                }
            };
        } catch (error) {
            console.error(`代理格式错误: ${proxyUrl}, 将使用默认代理`);
        }
    }

    // 使用默认代理生成方式
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

// 从文件读取代理列表
async function loadProxiesFromFile(filename) {
    try {
        if (!fs.existsSync(filename)) {
            console.error(`[${getBeijingTime()}] 代理文件 ${filename} 不存在`);
            return false;
        }

        const content = await crosschainTransactions.retryOperation(async () => {
            return fs.readFileSync(filename, 'utf8');
        }, 3, 5000);

        const proxies = content.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        if (proxies.length === 0) {
            console.error(`[${getBeijingTime()}] 代理文件为空`);
            return false;
        }

        customProxies = proxies;
        console.log(`[${getBeijingTime()}] 已加载 ${proxies.length} 个代理`);
        return true;
    } catch (error) {
        console.error(`[${getBeijingTime()}] 读取代理文件失败: ${error.message}`);
        return false;
    }
}

// 提示输入函数
function promptInput(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer);
        });
    });
}


// 按行读取助记词，每行一个
async function readMnemonicByLines() {
    try {
        const mnemonicContent = await crosschainTransactions.retryOperation(async () => {
            return fs.readFileSync('Phrase.txt', 'utf8');
        }, 3, 5000);

        // 按行分割，过滤空行
        const mnemonics = mnemonicContent.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        console.log(`[${getBeijingTime()}] 已读取 ${mnemonics.length} 个助记词`);
        return mnemonics;
    } catch (error) {
        console.error(`[${getBeijingTime()}] 无法读取助记词文件 Phrase.txt: ${error.message}`);
        process.exit(1);
    }
}

// 代理设置菜单
async function showProxyMenu() {
    console.log('\n===== 代理设置菜单 =====');
    console.log(`1. ${useProxy ? '禁用' : '启用'}代理`);
    console.log(`2. ${useCustomProxies ? '使用动态生成代理' : '使用自定义代理列表'}`);
    console.log('3. 从文件加载代理列表');
    console.log('4. 设置代理通道ID和密码');
    console.log('0. 返回主菜单');

    console.log(`\n当前代理状态: ${useProxy ? '已启用' : '已禁用'}`);
    console.log(`代理模式: ${useCustomProxies ? '自定义代理列表' : '动态生成代理'}`);
    if (useCustomProxies) {
        console.log(`已加载 ${customProxies.length} 个自定义代理`);
    }

    const choice = await promptInput('请选择操作: ');

    switch (choice) {
        case '1':
            useProxy = !useProxy;
            console.log(`代理已${useProxy ? '启用' : '禁用'}`);
            break;
        case '2':
            useCustomProxies = !useCustomProxies;
            console.log(`已切换为${useCustomProxies ? '自定义代理列表' : '动态生成代理'}`);
            break;
        case '3':
            const filename = await promptInput('请输入代理文件路径 (默认: proxy.txt): ') || 'proxy.txt';
            if (await loadProxiesFromFile(filename)) {
                useCustomProxies = true;
                console.log('已切换为自定义代理列表模式');
            }
            break;
        case '4':
            USERNAME = await promptInput(`请输入代理通道ID (当前: ${USERNAME}): `) || USERNAME;
            PASSWORD = await promptInput(`请输入代理密码 (当前: ${PASSWORD}): `) || PASSWORD;
            console.log('代理设置已更新');
            break;
        case '0':
            return;
        default:
            console.log('无效选择');
            break;
    }

    await promptInput('\n按Enter键继续...');
    return showProxyMenu();
}

// 高级设置菜单
async function showAdvancedMenu() {
    console.log('\n===== 高级设置菜单 =====');
    console.log('1. 设置交易次数');
    console.log('2. 设置线程数量');
    console.log(`3. ${autoRunEnabled ? '禁用' : '启用'}每日自动运行（北京时间9点）`);
    console.log('0. 返回主菜单');

    console.log(`\n当前交易次数: ${transactionCount}`);
    console.log(`当前线程数量: ${threadCount}`);
    console.log(`自动运行状态: ${autoRunEnabled ? '已启用' : '已禁用'}`);

    const choice = await promptInput('请选择操作: ');

    switch (choice) {
        case '1':
            const count = await promptInput('请输入每个钱包执行的交易次数 (1-500): ');
            const parsedCount = parseInt(count);
            if (!isNaN(parsedCount) && parsedCount > 0 && parsedCount <= 500) {
                transactionCount = parsedCount;
                console.log(`交易次数已设置为 ${transactionCount}`);
            } else {
                console.log('无效的交易次数，请输入1-100之间的数字');
            }
            break;
        case '2':
            const threads = await promptInput('请输入线程数量 (1-10): ');
            const parsedThreads = parseInt(threads);
            if (!isNaN(parsedThreads) && parsedThreads > 0 && parsedThreads <= 10) {
                threadCount = parsedThreads;
                console.log(`线程数量已设置为 ${threadCount}`);
            } else {
                console.log('无效的线程数量，请输入1-10之间的数字');
            }
            break;
        case '3':
            autoRunEnabled = !autoRunEnabled;
            console.log(`自动运行已${autoRunEnabled ? '启用' : '禁用'}`);
            if (autoRunEnabled) {
                setupAutoRun();
                console.log('已设置每日北京时间9点自动运行全部交易');
            }
            break;
        case '0':
            return;
        default:
            console.log('无效选择');
            break;
    }

    await promptInput('\n按Enter键继续...');
    return showAdvancedMenu();
}

// 设置自动运行
function setupAutoRun() {
    // 计算当前时区与北京时间(UTC+8)的差异
    const now = new Date();
    const localOffset = now.getTimezoneOffset();  // 本地时区与UTC的差异（分钟）
    const beijingOffset = -8 * 60;  // 北京时区与UTC的差异（分钟，东八区为负）
    const diffHours = (localOffset - beijingOffset) / 60;  // 本地时区与北京时区的差异（小时）

    // 计算本地时区对应北京时间9点的小时数
    let localHour = 9 - diffHours;
    // 处理跨日情况
    if (localHour < 0) localHour += 24;
    if (localHour >= 24) localHour -= 24;

    console.log(`[${getBeijingTime()}] 设置定时任务: 每天本地时间 ${Math.floor(localHour)}:${(localHour % 1) * 60} (对应北京时间9:00) 自动运行`);

    // 设置定时任务，在本地时区的对应时间执行
    cron.schedule(`0 ${Math.floor(localHour)} * * *`, () => {
        console.log(`[${getBeijingTime()}] 开始自动运行所有交易任务`);
        runAllTransactions();
    });
}

// 运行所有交易类型
async function runAllTransactions() {
    console.log(`[${getBeijingTime()}] 开始执行全部交易类型`);

    // 读取助记词
    const mnemonics = await readMnemonicByLines();
    if (mnemonics.length === 0) {
        console.log(`[${getBeijingTime()}] 没有找到有效的助记词，请检查 Phrase.txt 文件`);
        return false;
    }

    // 执行所有交易类型
    const transactionTypes = ['1', '2', '3', '4', '5', '6', '7'];
    const txTypeNames = {
        '1': 'Sei -> Baby',
        '2': 'Sei -> Xion',
        '3': 'Baby -> Holesky',
        '4': 'Baby -> Sepolia',
        '5': 'Xion -> Sei',
        '6': 'Baby -> BNB',
        '7': 'Baby -> Osmo'
    };

    let allResults = {};

    for (const txType of transactionTypes) {
        console.log(`\n[${getBeijingTime()}] 开始执行交易类型 ${txType} (${txTypeNames[txType]})`);
        console.log(`[${getBeijingTime()}] 每个钱包将执行 ${transactionCount} 次交易`);
        console.log(`[${getBeijingTime()}] 使用 ${threadCount} 个线程处理 ${mnemonics.length} 个钱包`);

        try {
            // 使用多线程执行交易
            const result = await runWithThreads(mnemonics, txType);
            allResults[txType] = result;

            const successRate = result.totalAttempts > 0 ?
                (result.totalSuccess / result.totalAttempts * 100).toFixed(2) : 0;

            console.log(`[${getBeijingTime()}] 交易类型 ${txType} (${txTypeNames[txType]}) 已完成，成功率: ${successRate}% (${result.totalSuccess}/${result.totalAttempts})`);
        } catch (error) {
            console.error(`[${getBeijingTime()}] 交易类型 ${txType} 执行失败: ${error.message}`);
            allResults[txType] = { totalSuccess: 0, totalAttempts: 0, error: error.message };
        }

    }

    // 汇总所有交易类型的结果
    let totalSuccess = 0;
    let totalAttempts = 0;

    console.log(`\n[${getBeijingTime()}] 所有交易类型执行结果汇总:`);

    for (const txType of transactionTypes) {
        const result = allResults[txType] || { totalSuccess: 0, totalAttempts: 0 };
        const successRate = result.totalAttempts > 0 ?
            (result.totalSuccess / result.totalAttempts * 100).toFixed(2) : 0;

        console.log(`[${getBeijingTime()}] ${txTypeNames[txType]}: 成功率 ${successRate}% (${result.totalSuccess}/${result.totalAttempts})`);

        totalSuccess += result.totalSuccess || 0;
        totalAttempts += result.totalAttempts || 0;
    }

    const overallSuccessRate = totalAttempts > 0 ?
        (totalSuccess / totalAttempts * 100).toFixed(2) : 0;

    console.log(`[${getBeijingTime()}] 总体成功率: ${overallSuccessRate}% (${totalSuccess}/${totalAttempts})`);
    console.log(`\n[${getBeijingTime()}] 所有交易类型已执行完毕`);

    return true;
}

// 工作线程函数
async function workerFunction(data) {
    const { mnemonic, txType, proxyUrl, txCount, threadId, totalThreads, mnemonicIndex, totalMnemonics } = data;

    try {
        console.log(`[${getBeijingTime()}][线程 ${threadId}/${totalThreads}] 开始处理助记词 ${mnemonicIndex}/${totalMnemonics}`);

        // 执行指定次数的交易
        let successCount = 0;
        let attemptCount = 0;

        while (successCount < txCount && attemptCount < txCount * 3) { // 最多尝试3倍次数
            attemptCount++;
            console.log(`[${getBeijingTime()}][线程 ${threadId}/${totalThreads}] 助记词 ${mnemonicIndex}/${totalMnemonics} - 交易尝试 ${attemptCount}, 成功 ${successCount}/${txCount}`);

            let result = false;
            switch (txType) {
                case '1':
                    result = await crosschainTransactions.transferSeiBaby(mnemonic, proxyUrl, mnemonicIndex);
                    break;
                case '2':
                    result = await crosschainTransactions.transferSeiXion(mnemonic, proxyUrl, mnemonicIndex);
                    break;
                case '3':
                    result = await crosschainTransactions.transferBabyHolesky(mnemonic, proxyUrl, mnemonicIndex);
                    break;
                case '4':
                    result = await crosschainTransactions.transferBabySepolia(mnemonic, proxyUrl, mnemonicIndex);
                    break;
                case '5':
                    result = await crosschainTransactions.transferXionSei(mnemonic, proxyUrl, mnemonicIndex);
                    break;
                case '6':
                    result = await crosschainTransactions.transferBabyBNB(mnemonic, proxyUrl, mnemonicIndex);
                    break;
                case '7':
                    result = await crosschainTransactions.transferBabyOsmo(mnemonic, proxyUrl, mnemonicIndex);
                    break;
            }

            if (result === true) {
                successCount++;
                console.log(`[${getBeijingTime()}][线程 ${threadId}/${totalThreads}] 助记词 ${mnemonicIndex}/${totalMnemonics} - 交易成功 ${successCount}/${txCount}`);
            } else {
                console.log(`[${getBeijingTime()}][线程 ${threadId}/${totalThreads}] 助记词 ${mnemonicIndex}/${totalMnemonics} - 交易失败，将重试`);
            }

            // 添加随机延迟
            // const delay = Math.floor(Math.random() * 3000) + 2000; // 2-5秒随机延迟
            // console.log(`[${getBeijingTime()}][线程 ${threadId}/${totalThreads}] 等待 ${delay / 1000} 秒后继续...`);
            // await new Promise(resolve => setTimeout(resolve, delay));
        }

        if (successCount < txCount) {
            console.log(`[${getBeijingTime()}][线程 ${threadId}/${totalThreads}] 助记词 ${mnemonicIndex}/${totalMnemonics} - 已达到最大尝试次数，成功完成 ${successCount}/${txCount} 次交易`);
        } else {
            console.log(`[${getBeijingTime()}][线程 ${threadId}/${totalThreads}] 助记词 ${mnemonicIndex}/${totalMnemonics} - 成功完成所有 ${txCount} 次交易`);
        }

        return { success: successCount > 0, mnemonicIndex, successCount, totalTxCount: txCount };
    } catch (error) {
        console.error(`[线程 ${threadId}/${totalThreads}] 处理助记词 ${mnemonicIndex}/${totalMnemonics} 时出错: ${error.message}`);
        return { success: false, mnemonicIndex, error: error.message, successCount: 0, totalTxCount: txCount };
    }
}

// 多线程执行交易
async function runWithThreads(mnemonics, txType) {
    // 如果只有一个线程，直接在主线程执行
    if (threadCount === 1) {
        let totalSuccess = 0;
        let totalAttempts = 0;

        for (let i = 0; i < mnemonics.length; i++) {
            const mnemonic = mnemonics[i];
            console.log(`\n[${getBeijingTime()}][1/1] 处理助记词 ${i + 1}/${mnemonics.length}...`);

            // 为每个交易生成随机代理
            let proxyUrl = null;
            if (useProxy) {
                const proxyInfo = generateProxy();
                proxyUrl = proxyInfo.proxyUrl;
                console.log(`[${getBeijingTime()}] 使用代理: ${proxyUrl}`);
            } else {
                console.log(`[${getBeijingTime()}] 不使用代理`);
            }

            const result = await workerFunction({
                mnemonic,
                txType,
                proxyUrl,
                txCount: transactionCount,
                threadId: 1,
                totalThreads: 1,
                mnemonicIndex: i + 1,
                totalMnemonics: mnemonics.length
            });

            totalSuccess += result.successCount || 0;
            totalAttempts += result.totalTxCount || 0;
        }

        console.log(`\n[${getBeijingTime()}] 所有钱包处理完成，成功交易: ${totalSuccess}/${totalAttempts}`);
        return { totalSuccess, totalAttempts };
    }

    // 多线程执行
    return new Promise((resolve) => {
        // 创建任务队列
        const tasks = [];
        for (let i = 0; i < mnemonics.length; i++) {
            // 为每个任务生成随机代理
            let proxyUrl = null;
            if (useProxy) {
                const proxyInfo = generateProxy();
                proxyUrl = proxyInfo.proxyUrl;
            }

            tasks.push({
                mnemonic: mnemonics[i],
                txType,
                proxyUrl,
                txCount: transactionCount,
                mnemonicIndex: i + 1,
                totalMnemonics: mnemonics.length
            });
        }

        // 创建工作线程
        const workers = [];
        const results = [];
        let completedTasks = 0;
        const actualThreadCount = Math.min(threadCount, tasks.length);
        let totalSuccess = 0;
        let totalAttempts = 0;

        console.log(`[${getBeijingTime()}] 启动 ${actualThreadCount} 个工作线程处理 ${tasks.length} 个任务`);

        for (let i = 0; i < actualThreadCount; i++) {
            const worker = new Worker(__filename, {
                workerData: { isWorker: true }
            });

            worker.on('message', (result) => {
                results.push(result);
                completedTasks++;
                totalSuccess += result.successCount || 0;
                totalAttempts += result.totalTxCount || 0;

                // 如果还有任务，分配给工作线程
                if (tasks.length > 0) {
                    const task = tasks.shift();
                    worker.postMessage({
                        ...task,
                        threadId: i + 1,
                        totalThreads: actualThreadCount
                    });
                } else if (completedTasks === mnemonics.length) {
                    // 所有任务完成，终止所有工作线程
                    console.log(`\n[${getBeijingTime()}] 所有钱包处理完成，成功交易: ${totalSuccess}/${totalAttempts}`);
                    workers.forEach(w => w.terminate());
                    resolve({ results, totalSuccess, totalAttempts });
                }
            });

            worker.on('error', (error) => {
                console.error(`工作线程 ${i + 1} 发生错误:`, error);
                completedTasks++;

                if (completedTasks === mnemonics.length) {
                    console.log(`\n[${getBeijingTime()}] 所有钱包处理完成，成功交易: ${totalSuccess}/${totalAttempts}`);
                    workers.forEach(w => w.terminate());
                    resolve({ results, totalSuccess, totalAttempts });
                }
            });

            workers.push(worker);

            // 分配初始任务
            if (tasks.length > 0) {
                const task = tasks.shift();
                worker.postMessage({
                    ...task,
                    threadId: i + 1,
                    totalThreads: actualThreadCount
                });
            }
        }
    });
}

// 跨链交易菜单
async function showCrosschainMenu() {
    console.log('\n===== 跨链交易菜单 =====');
    console.log('1. Sei -> Baby');
    console.log('2. Sei -> Xion');
    console.log('3. Baby -> Holesky');
    console.log('4. Baby -> Sepolia');
    console.log('5. Xion -> Sei');
    console.log('6. Baby -> BNB');
    console.log('7. Baby -> Osmo');
    console.log('8. 全部运行');
    console.log('9. 代理设置');
    console.log('10. 高级设置');
    console.log('0. 退出');

    console.log(`\n当前代理状态: ${useProxy ? '已启用' : '已禁用'}`);
    if (useProxy) {
        console.log(`代理模式: ${useCustomProxies ? '自定义代理列表' : '动态生成代理'}`);
    }
    console.log(`交易次数: ${transactionCount}`);
    console.log(`线程数量: ${threadCount}`);
    console.log(`自动运行状态: ${autoRunEnabled ? '已启用' : '已禁用'}`);

    const choice = await promptInput('请选择跨链交易类型: ');

    if (choice === '0') {
        console.log('感谢使用，再见!');
        process.exit(0);
    }

    // 代理设置
    if (choice === '9') {
        await showProxyMenu();
        return showCrosschainMenu();
    }

    // 高级设置
    if (choice === '10') {
        await showAdvancedMenu();
        return showCrosschainMenu();
    }

    // 全部运行
    if (choice === '8') {
        await runAllTransactions();
        // 按任意键继续
        return showCrosschainMenu();
    }

    // 检查是否是有效的交易类型选择
    if (!['1', '2', '3', '4', '5', '6', '7'].includes(choice)) {
        console.log('无效选择');
        await promptInput('\n按Enter键继续...');
        return showCrosschainMenu();
    }

    // 读取助记词（按行）
    const mnemonics = await readMnemonicByLines();
    if (mnemonics.length === 0) {
        console.log('没有找到有效的助记词，请检查 Phrase.txt 文件');
        await promptInput('\n按Enter键继续...');
        return showCrosschainMenu();
    }

    // 根据选择调用相应函数
    try {
        console.log(`[${getBeijingTime()}] 开始执行交易，每个钱包将执行 ${transactionCount} 次交易`);
        console.log(`[${getBeijingTime()}] 使用 ${threadCount} 个线程处理 ${mnemonics.length} 个钱包`);

        // 使用多线程执行交易
        await runWithThreads(mnemonics, choice);

        console.log(`\n[${getBeijingTime()}] 所有交易已完成`);
    } catch (error) {
        console.error(`[${getBeijingTime()}] 交易执行失败: ${error.message}`);
    }

    // 按任意键继续
    await promptInput('\n按Enter键继续...');
    showCrosschainMenu();
}

// 如果是工作线程，执行工作线程函数
if (!isMainThread && workerData && workerData.isWorker) {
    parentPort.on('message', async (data) => {
        try {
            const result = await workerFunction(data);
            parentPort.postMessage(result);
        } catch (error) {
            parentPort.postMessage({
                success: false,
                mnemonicIndex: data.mnemonicIndex,
                error: error.message
            });
        }
    });
} else {
    // 主线程启动程序
    (async function () {
        console.log(`[${getBeijingTime()}] 欢迎使用跨链交易工具`);
        // 尝试加载代理文件
        if (fs.existsSync('proxy.txt')) {
            if (await loadProxiesFromFile('proxy.txt')) {
                console.log('已自动加载代理文件 proxy.txt');
            }
        }
        await showCrosschainMenu();
    })();

    // 处理退出
    rl.on('close', () => {
        console.log('感谢使用，再见!');
        process.exit(0);
    });
} 