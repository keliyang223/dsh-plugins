# DSH File to Chat

[English](README.en.md)

**DSH File to Chat** 是 DeepSeek Harness（DSH）Web 插件，可将文件、文件夹或文本预览中选中的行范围插入当前对话草稿，方便 AI 查看相关上下文。

## 功能

- 在文件树中文件或文件夹上右键，选择“加入到对话框”插入路径。
- 在文本预览中选中一行或多行后右键，选择“加入选中行到对话框”插入路径和行号，例如：`@/path/to/file 第 12–20 行`。
- 支持带空格的路径；不发送消息、不读取或上传文件内容。

## 安装

```sh
dsh plugin --profile web add "git+https://github.com/keliyang223/dsh-file-to-chat.git"
```

若插件未自动加载，请重启 DSH Web 并刷新页面。卸载：

```sh
dsh plugin --profile web remove dsh-file-to-chat
```

更多用法、行号支持范围和开发测试说明见 [English README](README.en.md)。