# 课程表与作业提醒

一个单用户的全栈小应用：登录后查看按周排列的课表，记录每门课的作业和截止日期。

课程支持「每周 / 单周 / 双周」：填一条记录，就会自动出现在所有对应的周次里，不需要每周复制一遍；修改时也是改一次、全部同步。

节次时间可以在「设置」里逐节填写，课表左侧会显示每节的开始时间，添加课程时会提示所选节次对应的时段。

「设置」里还有一键清空：删除全部课程和作业，账号和节次时间保留。

## 技术栈

| 层 | 选择 | 说明 |
| --- | --- | --- |
| 前端 | 原生 HTML / CSS / JavaScript | 无框架，和作品集保持同一套风格 |
| 后端 | Node.js + Express | REST 接口，JSON 传输 |
| 数据库 | SQLite（Node 内置 `node:sqlite`） | 不用安装数据库软件，数据存在 `data/app.db` |
| 鉴权 | scrypt 加盐哈希 + 会话 Cookie | 密码不存明文，Cookie 带 HttpOnly |

## 运行

```powershell
cd D:\self\dev\course-planner
D:\self\dev\node\npm.cmd install
D:\self\dev\node\node.exe server.js
```

打开 http://localhost:3000 ，第一次会要求设置密码。

## 目录

```
server.js       接口与鉴权
db.js           建表语句、数据库连接
public/
  index.html    页面骨架
  app.js        界面渲染与交互
  app.css       样式
data/app.db     SQLite 数据文件（已被 .gitignore 忽略）
```

## 数据表

- `users`：账号与密码哈希
- `courses`：课程名、星期、节次、周次范围、单双周（`week_parity`）、地点、颜色
- `assignments`：标题、关联课程、截止日期、完成状态
- `periods`：12 个节次的开始与结束时间
- `settings`：学期起始日期等键值配置

## 注意

- 第一次部署后请立刻访问站点设置密码，否则谁能先打开谁就能占用账号。
- 密码忘记只能删除 `data/app.db` 重新开始（会丢失全部课程和作业）。
