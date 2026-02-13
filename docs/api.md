# 滴答清单 V2 API 接口文档

基础地址: `https://api.dida365.com/api/v2`

认证方式: Cookie `t={token}`

> 参考文档: https://2977094657.github.io/DidaAPI/api/

## 认证

### 密码登录

```
POST /user/signon?wc=true&remember=true
Content-Type: application/json

# 手机号登录
{ "phone": "18100000000", "password": "xxx" }

# 邮箱登录
{ "username": "user@example.com", "password": "xxx" }
```

**响应:**
```json
{ "token": "xxx", "userId": "xxx", "inboxId": "inbox123" }
```

### 微信扫码登录

完整流程共 4 步：

**1. 获取二维码**

```
GET https://open.weixin.qq.com/connect/qrconnect
  ?appid=wxf1429a73d311aad4
  &redirect_uri=https://dida365.com/sign/wechat
  &response_type=code
  &scope=snsapi_login
  &state=Lw==
```

从返回的 HTML 中提取 UUID：`<img src="/connect/qrcode/{uuid}">`

二维码图片地址：`https://open.weixin.qq.com/connect/qrcode/{uuid}`

**2. 轮询扫码状态**

```
GET https://long.open.weixin.qq.com/connect/l/qrconnect?uuid={uuid}&_={timestamp}
```

响应为 JavaScript：
- `wx_errcode=408` — 等待扫码
- `wx_errcode=404` — 已扫码，等待确认
- `wx_errcode=405` — 已确认，`wx_code` 包含授权码
- `wx_errcode=402/403` — 二维码过期

```javascript
window.wx_errcode=405;window.wx_code='AUTH_CODE_HERE';
```

**3. 用授权码验证**

```
GET /user/sign/wechat/validate?code={code}&state=Lw==
```

**4. 获取 token**

token 在响应的 `Set-Cookie` 头中：

```
Set-Cookie: t={token}; Domain=.dida365.com; ...
```

## 用户

### 获取用户资料

```
GET /user/profile
```

**响应字段:** `username`, `email`, `name`, `displayName`, `picture`, `phone`, `locale`, `gender`

## 项目/清单

### 获取清单列表

```
GET /projects
```

**响应:** `Project[]` — 包含 `id`, `name`, `kind`, `viewMode`, `color`, `sortOrder` 等

## 任务

### 获取全量数据（批量）

```
GET /batch/check/0
```

一次性返回所有项目 + 活跃任务 + 标签。

**响应:**
```json
{
  "checkPoint": 12345,
  "syncTaskBean": {
    "update": [Task],
    "delete": ["id"],
    "add": [Task],
    "empty": false
  },
  "projectProfiles": [Project],
  "tags": [Tag],
  "inboxId": "inbox123"
}
```

### 获取已完成/已放弃任务

```
GET /project/all/closed?from=&status=Completed
GET /project/all/closed?from=&status=Abandoned
```

**分页:** 每页 50 条，用上一页最后一条的 `completedTime` 作为 `to` 参数继续翻页。

**响应:** `Task[]`

### 获取垃圾桶任务

```
GET /project/all/trash/page?limit=50
```

**响应:**
```json
{ "tasks": [Task], "next": 50 }
```

分页: 用 `next` 值作为下次请求的 `start` 参数。

### 获取任务统计

```
GET /tasks/summary
```

**响应:**
```json
{
  "total_tasks": 150,
  "completed_tasks": 120,
  "pending_tasks": 30,
  "completion_rate": 80.0
}
```

## 通用请求头

所有请求需携带以下 Headers:

```
User-Agent: Mozilla/5.0 (Macintosh; ...) Chrome/144.0.0.0
Origin: https://dida365.com
Referer: https://dida365.com/
Sec-Fetch-Site: same-site
X-Requested-With: XMLHttpRequest
X-Csrftoken: (空)
X-Device: {"platform":"web","os":"macOS","device":"Chrome","version":8021,...}
Cookie: t={token}
```
