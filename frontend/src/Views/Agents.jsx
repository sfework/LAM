import React from 'react';
import { Form } from '@douyinfe/semi-ui';
import { AssetPage } from '../Common/AssetPage';

/**
 * Agents 页（/api/agents，DESIGN §2.5）：name/description/body/enabled/sortOrder。
 * 与技能/知识库同构：列表显示描述（不显示正文），启用仅列表切换，按 sortOrder 升序。描述、正文必填。
 */
export default function Agents() {
    return <AssetPage
        resource='agents'
        titleKey='name'
        renderForm={() => (
            <Form.TextArea field='body' label='正文' rows={10} style={{ width: '100%' }}
                placeholder='Agent 正文（子智能体定义说明），经 MCP 工具按需读取'
                rules={{ required: true, whitespace: true, message: '正文不能为空' }} />
        )}
        buildBody={(values) => ({ body: values.body })}
    />;
}
