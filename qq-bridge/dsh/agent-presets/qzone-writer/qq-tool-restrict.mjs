// re-export 壳：qq-tool-restrict 的权威实现只有一份，在
// plugins/qq-agent-presets/qq-tool-restrict.mjs（bundle 内，preset 行按包名引用）。
//
// 与 qq-chat / qq-chat-v2 一样保留这个壳，供仓库里按 preset 目录 import/读文件的
// 脚本（test-agent-preset-patches.mjs 等）继续工作，并明确指向唯一实现。
// 注意：qzone-writer 真正的“禁止一切工具”边界是 qzone-writer-guard，不是这个共享守卫。
export * from '../../../plugins/qq-agent-presets/qq-tool-restrict.mjs'
