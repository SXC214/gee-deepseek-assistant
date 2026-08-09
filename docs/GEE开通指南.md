# Google Earth Engine 开通指南（非商业 / 科研用途）

> ⚠️ **重要提醒：该开通流程似乎只支持谷歌邮箱（Gmail / Google 账号）。**
>
> 实测中，整个注册与授权流程基本只能通过 Google 账号完成；使用非谷歌邮箱（QQ 邮箱、163 邮箱、企业邮箱等）很可能无法完成注册或授权。如果你手头没有 Google 账号，建议先注册一个 Gmail 邮箱，或使用学校提供的 Google Workspace 账号。
>
> （注：这是基于实操截图的观察结论，保留一定不确定性——官方未明确声明"仅限 Gmail"，但实际流程中未见其他邮箱的成功路径。）

本指南基于实际开通过程的 13 张截图整理，介绍如何为 **非商业与科研用途（Noncommercial and Research Use）** 开通 Google Earth Engine（GEE）。按以下步骤操作即可完成从入口访问到 Code Editor 可用的全流程。

---

## 步骤总览

| 步骤 | 内容 |
| --- | --- |
| 1 | 进入非商业入口页面 |
| 2 | 选择 Google 账号登录 |
| 3 | 进入 Google Cloud 控制台的 Earth Engine 配置页 |
| 4 | 创建 Google Cloud 项目 |
| 5 | 注册第 ① 步：选择组织类型 |
| 6 | 注册第 ② 步：非商业资格核验 |
| 7 | 注册第 ③ 步：选择计划（Community / Contributor） |
| 8 | 注册第 ④ 步：描述你的工作 |
| 9 | 注册第 ⑤ 步：Review summary 核对信息 |
| 10 | 提交注册并启用 Earth Engine API（⚠️ 易踩坑） |
| 11 | 注册完成，开始使用 Code Editor |

---

## 1. 进入非商业入口

访问 **<https://earthengine.google.com/noncommercial/>**。

- 页面顶部导航栏中 **Noncommercial** 项处于高亮选中状态。
- 页面标题介绍 **Earth Engine for Noncommercial and Research Use**（面向非商业与科研用途的 Earth Engine）。
- 点击页面上的蓝色 **Get Started** 按钮，开始开通流程。

## 2. 选择 Google 账号

点击 Get Started 后跳转到 Google 登录页面，提示 **「Choose an account to continue to Earth Engine Code Editor」**。

- 选择列表中已有的 Google 账号，或登录你的 Google 账号。
- 再次呼应开头的提醒：**此处基本只能使用谷歌邮箱（Google 账号）**，非谷歌邮箱大概率走不通这一步。

## 3. 进入 Google Cloud 控制台 Earth Engine 配置页

登录后自动跳转到 Google Cloud 控制台（`console.cloud.google.com`）：

- 在左侧导航菜单中选择 **Earth Engine → Configuration**。
- 如果此时尚未选择项目，页面会提示 **「To view this page, select a project」**，需要先创建一个项目（见下一步）。

## 4. 创建项目

在提示处点击 **Create project**，进入 **New Project** 页面：

| 字段 | 填写说明 |
| --- | --- |
| Project name | 项目名称，如 `GEE project` |
| Organization | 可选 **No organization** |
| Parent resource | 保持默认即可 |

填写完成后点击 **Create** 创建项目。

> ⚠️ 注意：项目 ID 生成后**不可修改**，请留意名称填写无误。

## 5. 注册第 ① 步：选择组织类型

回到 **Earth Engine → Configuration** 页面，点击 **Register** 开始注册，进入 **「Select your organization type」** 页面。

下拉选项包括：公司、学术机构、非营利组织、政府机构、媒体、培训用途、其他等。

- **学生与科研人员请选择：`Public or private academic institution (including faculty, staff, students)`**（公立或私立学术机构，含教职工、员工、学生）。

## 6. 注册第 ② 步：非商业资格核验

此步骤需要用**英文**依次填写以下信息：

1. **学术机构英文全称**：填写所在学校 / 研究机构的官方英文名。
2. **是否从商业实体获得报酬**：选择 **No**。
3. **使用性质**：在 Scientific research（科学研究）/ Decision making（决策支持）中选择；科研用途选 **Scientific research**。
4. **研究问题（必填）**：写明具体的研究方向，建议写得具体一些，避免空泛描述。
5. **研究的地理范围**：选择 **Global**（全球）或 **Regional**（区域）。
6. **是否已有使用 Earth Engine 的发表成果**：首次申请选 **No**。

## 7. 注册第 ③ 步：选择计划（Choose your plan）

系统会先显示资格判定结果：

> **「Based on your answers, you are eligible for noncommercial Earth Engine use」**

点击 **Next** 后进入计划选择页面。两种计划对比如下：

| 对比项 | Community | Contributor |
| --- | --- | --- |
| 额度 | 约 **150 EECU-hour** | 约 **1,000 EECU-hour** |
| 账单账户 | **无需账单账户（不需要信用卡）** | 需要活跃的账单账户 |
| 信用卡要求 | 无 | 需要**海外实体信用卡**；风控严格，虚拟信用卡不被接受 |
| 超额行为 | — | 超额后进入受限模式 |

**选择建议：没有海外实体信用卡就选 Community。** 该计划无需任何信用卡，对绝大多数学生与科研人员已经够用。

## 8. 注册第 ④ 步：描述你的工作

- **工作类别**：选项包括 Mitigation（减缓）/ Adaptation（适应）/ Protection & conservation（保护与保育），可如实勾选，也可随意勾选。
- **「Will you use Earth Engine for any of the following?」**：下拉选项，**必填**，按实际情况选择即可。

## 9. 注册第 ⑤ 步：Review summary

核对全部已填信息，包括组织类型、机构名称、使用性质、研究问题等。确认无误后提交。

## 10. 提交注册并启用 API（⚠️ 易踩坑）

点击 **Register** 提交后，会弹出 **「Enable APIs」** 对话框，提示：

> **To complete registration, please enable the Earth Engine API.**

> ⚠️ **务必点击对话框中的 Enable 按钮，激活 Earth Engine API 之后再离开页面。**
> 如果此时直接退出，会导致注册不完整，后续使用会出问题。

## 11. 注册完成

API 启用后，回到 Configuration 页面会看到注册成功提示：

- **「Your project is now registered for noncommercial use」**
- **「signed up for the Community Tier」**（已注册 Community 计划档位）
- 页面还提供 **Manage your EECU-time usage** 入口，可查看月度 EECU 用量，并通过 **Manage quota limits** 设置用量上限。

完成后，即可前往 **<https://code.earthengine.google.com>** 使用 Code Editor，开始你的 Earth Engine 之旅。

> 💡 到这里，GEE 账号开通已全部完成。如果你还想让 **本扩展**接入 GEE 资产（assets）与 REST 直连能力，请继续阅读本文 **第二部分：配置 OAuth 客户端（接入资产 / REST 能力）**。

---

# 第二部分：配置 OAuth 客户端（接入资产 / REST 能力）

本部分与第一部分的 GEE 账号开通相对独立，目标是为 **GEE AI 辅助助手扩展** 创建一个 Google OAuth 客户端，使扩展能够访问你的 GEE 资产（assets）并通过 REST 直连 GEE。以下步骤基于第二批实操截图整理，按顺序操作即可。

## 1. 回到 Google Cloud 控制台

在 Earth Engine 配置页面，点击左上角的 **「Google Cloud」Logo** 即可返回控制台首页；也可以直接使用顶部搜索栏进入下一步。

## 2. 搜索进入 APIs & Services

在控制台顶部搜索栏输入 `api`，在搜索结果中选择 **「APIs & Services」**（标注为 Product · API management for cloud services）。

## 3. 进入 OAuth 同意屏幕

在左侧导航中点击 **「OAuth consent screen」**（现已整合进新界面 **Google Auth Platform**）。

- 如果页面提示 **「Google Auth Platform not configured yet」**，点击 **Get started** 开始配置。

## 4. 第 1 步：App Information

- **App name**：可自定义应用名称（如 `GEE assistance`）。
- **User support email**：选择自己的邮箱即可。

## 5. 第 2 步：Audience

选择 **External**，点击 **Next**。

> ⚠️ 注意：External 应用初始处于 **Testing（测试）模式**，仅测试用户可用——这一点会在后文第 11 步产生关键影响。

## 6. 第 3 步：Contact Information

**Email addresses** 依旧填写自己的邮箱，然后一路 **Next** 继续。

## 7. 第 4 步：Finish

勾选同意 **Google API Services: User Data Policy**，点击 **Continue**。

> ⚠️ **不要忘记点击 Create**，否则 OAuth 配置不会被创建。

## 8. 创建 OAuth 客户端

创建完成后，页面提示 **「OAuth configuration created!」**，点击 **Create OAuth client** 继续：

- **Application type**：选择 **Web application**（下拉中也有 Chrome Extension 等选项，按本教程选 Web application）。
- **Name**：可保持默认（如 `Web client 1`）。

## 9. 从扩展复制回调地址（关键）

先打开本扩展的侧栏设置面板：

- 在 **「Google OAuth 客户端 ID（可选）」** 字段下方，会显示形如 `https://<扩展ID>.chromiumapp.org/` 的重定向地址。
- 点击旁边的 **「复制」** 按钮，把这个地址复制下来。

## 10. 填入重定向 URI

回到 Create OAuth client 页面：

- 在 **Authorized redirect URIs** 下点击 **「+ Add URI」**，把刚复制的 `chromiumapp.org` 地址粘贴进去。
- 点击 **Create**。

> 💡 提示：配置生效可能需要 **5 分钟到几小时**，创建后如授权未立即生效请稍作等待。

## 11. 复制 Client ID 并添加测试用户（⚠️ 易踩坑）

### 11.1 复制 Client ID

页面弹出 **「OAuth client created」** 对话框：

- 复制 **Client ID**（形如 `xxxx.apps.googleusercontent.com`）。
- 注意弹窗中的提示：**「OAuth access is restricted to the test users listed on your OAuth consent screen」**。

### 11.2 添加测试用户

进入 Google Auth Platform 左侧导航的 **「Audience」** 页面：

- 页面显示 **Publishing status = Testing**：该状态下只有测试用户才能访问应用；且在应用通过验证之前，测试用户**上限 100 个，按应用全生命周期累计**。
- 在页面下方的 **「Test users」** 区块点击 **「+ Add users」**。
- **添加你自己的邮箱——即开通 GEE 所用的那个邮箱。**

> ⚠️ 不做此步，扩展授权时会报 `403: access_denied` / Access blocked。相关说明可参见 `README.md`「REST 直连」章节中关于测试用户的描述。

## 12. 填回扩展并完成授权

打开扩展侧栏设置面板：

- 把复制的 **Client ID**（形如 `xxxx.apps.googleusercontent.com`）粘贴进 **「Google OAuth 客户端 ID（可选）」** 字段（该字段下方会显示扩展的 `chromiumapp.org` 回调地址与复制按钮，即本部分第 9 步用过的地址，此处无需再操作）。
- 连同 **「Earth Engine Project ID（可选）」**（即第一部分步骤 4 创建的 GCP 项目 ID）一起填写，点击 **「保存设置」**。
- 客户端 ID 只保存在**本浏览器**中。

保存后，在 **「资产 / 任务」** 面板点击授权：

- 浏览器会弹出 Google 登录页面，**选择刚加入测试用户的那个邮箱**。
- 授权成功后即可浏览资产 / 任务，并可使用 Shapefile 上传功能。

---

## 常见问题

**Q1：我没有 Gmail / Google 账号，用 QQ、163 或企业邮箱注册失败了怎么办？**

该流程似乎只支持谷歌邮箱。建议二选一：

- 新建一个 **Gmail** 邮箱（免费注册）；
- 或使用所在学校提供的 **Google Workspace** 账号（如果学校已开通）。

**Q2：提交注册后多久能用？需要等待审核吗？**

注册完成后若提示成功并已启用 Earth Engine API，通常即可使用；如个别功能暂未生效，请耐心等待一段时间（审核 / 生效可能有延迟），稍后重新访问 Code Editor 再试。

**Q3：账号安全方面有什么建议？**

建议为用于 GEE 的 Google 账号开启**两步验证（2FA）**，保护账号与项目安全。

**Q4：这个 GCP 项目和 GEE AI 辅助助手扩展有什么关系？**

本扩展的 **REST 直连**与 **Shapefile 云端上传**功能需要使用 **GCP 项目 ID**，即本文第一部分步骤 4 中创建的项目；OAuth 客户端配置步骤见本文第二部分，详细说明也可参见同目录下 `ISSUES.md` 与 `README.md`。

**Q5：扩展授权时报 `403: access_denied` / Access blocked 怎么办？**

这通常是因为 OAuth 应用处于 Testing 模式且你不在测试用户列表中。到 Google Cloud 控制台 **Audience / Test users** 把自己的 Google 账号加入测试用户后重试（见第二部分步骤 11）。

**Q6：授权过一段时间后失效了？**

OAuth 令牌约 **7 天**过期后需要重新授权，这是 README 中已确认的结论，属预期行为，重新在扩展内完成一次授权即可。
