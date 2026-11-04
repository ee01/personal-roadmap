已创建项目 **GitLab MR**：[personal-roadmap !1](https://git.ringcentral.com/esone.qiu/personal-roadmap/-/merge_requests/1)，提交 `4463754`。

参考 MR !4199 确实是“运行时镜像 + PVC 源码”的方向，但 PVC 不会自动接收 GitLab 提交。PEP 通过管理页重启脚本执行拉代码、同步依赖和重启进程；本 MR 为 Roadmap 提供容器启动时拉取源码、构建独立 release 并启动 Node 的实现，SQLite 数据保存在独立目录，同时包含 K8S 清单和 ArgoCD 示例。

**后续提交 GitLab 不会直接自动上线。** 首次需完成运行时镜像推送、Git Secret、PVC/数据迁移、域名及平台配置；之后合并 main、确认 CI 通过，再执行：

```bash
kubectl -n app-tools rollout restart deployment/personal-roadmap
kubectl -n app-tools rollout status deployment/personal-roadmap --timeout=15m
```

新 Pod 会拉取代码到 PVC、安装依赖、构建并启动。普通业务更新不必重建运行时镜像；发布有停机窗口。若要 main 全自动上线，还需配置集群部署凭据/runner 和部署 job，当前 CI 只做验证。

完整步骤、数据迁移、回滚和首次验收见 [部署说明](https://git.ringcentral.com/esone.qiu/personal-roadmap/-/blob/feat/e-140-k8s-source-launcher/docs/deployment/k8s.md)，已附文档。

本地 313 个测试、构建、Shell 检查和 Kustomize 渲染通过。参考 MR 的 Git 源码已核查，但指定评论因缺少网页登录未读取。Docker daemon 未运行且没有 K8S context，因此未推镜像、未部署集群、未验证线上 health 或执行生产迁移；无新增业务接口。域名/集群配置需平台确认。此次仅提交任务分支，未部署 Mac mini，现有站点未切换。
