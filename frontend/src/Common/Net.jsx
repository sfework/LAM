import { ToastUI } from './Component.jsx';
import { NetBase, NetBaseConfig } from '@sfework/common';

/**
 * 请求层（DESIGN 决策 47）：复用 @sfework/common 的 NetBase，area='api'。
 * 调用姿势：Net.api.<资源>.<动作>(body) → POST /api/<资源>/<动作>，body 为 JSON。
 *   - 多段资源/动作用方括号取属性保留连字符：
 *       Net.api['denoise-rules']['get-by-path']({ path })
 *       Net.api.memories['rebuild-profile']({ project_path })
 *   - 返回体即后端包络 { success, code, message, data }；列表接口的 data 为 PaginationModel。
 * callBack：统一错误提示（后端 message 直出）。401 类静默（本项目无鉴权，保留分支以防未来）。
 */
const config = new NetBaseConfig();
config.area = 'api';
config.callBack = (request, result) => {
  if (!result.success) {
    if (result.code === 401) {
      // 预留：将来若加鉴权，此处跳登录。本地无鉴权不会触发。
      return;
    }
    ToastUI.error(result.message || `请求失败（${result.code ?? '未知'}）`);
  }
};

const Net = new NetBase(config);

export default Net;
