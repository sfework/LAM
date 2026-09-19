import React from 'react';
import { Form } from '@douyinfe/semi-ui';
import { AssetPage } from '../Common/AssetPage';

/**
 * 技能页（/api/skills，DESIGN §2.4）：name/description/body/enabled/sortOrder。
 * 列表显示描述（不显示正文），启用仅列表切换，按 sortOrder 升序。描述、正文必填。
 */
export default function Skills() {
    return <AssetPage
        resource='skills'
        titleKey='name'
        renderForm={() => (
            <Form.TextArea field='body' label='正文' rows={10} style={{ width: '100%' }}
                placeholder='技能正文（Markdown），经 MCP 工具按需读取'
                rules={{ required: true, whitespace: true, message: '正文不能为空' }} />
        )}
        buildBody={(values) => ({ body: values.body })}
    />;
}
