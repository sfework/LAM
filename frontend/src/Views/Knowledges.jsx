import React from 'react';
import { Form, Tag, Row, Col } from '@douyinfe/semi-ui';
import { AssetPage } from '../Common/AssetPage';
import Net from '../Common/Net';

const scopeOptions = [
    { label: '全局', value: 'global' },
    { label: '项目', value: 'project' },
];

/**
 * 知识库页（/api/knowledge，DESIGN §2.5）：title/description/body/scope/projectId/enabled/sortOrder。
 * 列表显示描述（不显示正文），额外列展示范围（全局/项目名）；启用仅列表切换，按 sortOrder 升序。
 * scope=project 时须绑定项目（projectId 从项目列表下拉选择）。
 */
export default function Knowledges() {
    return <AssetPage
        resource='knowledge'
        titleKey='title'
        createDefaults={{ scope: 'global', body: '' }}
        validate={(values) => (values.scope === 'project' && !values.projectId ? '范围选择「项目」时必须绑定项目' : '')}
        loadOptions={() =>
            Net.api.projects.list({ page: 1, pageSize: 1000 }).then(r =>
                ({ projects: r.success ? r.data.list.map(p => ({ label: p.name, value: p.id })) : [] }))
        }
        extraColumns={(options) => [
            {
                title: '范围', dataIndex: 'scope', width: 130,
                render: (text, item) => {
                    if (text !== 'project') return <Tag color='green'>全局</Tag>;
                    const p = (options.projects || []).find(x => x.value === item.projectId);
                    return <Tag color='cyan'>{p ? p.label : (item.projectId || '项目')}</Tag>;
                },
            },
        ]}
        renderForm={(data, options) => (
            <>
                <Row gutter={16}>
                    <Col span={5}>
                        <Form.Select field='scope' label='范围' style={{ width: '100%' }} optionList={scopeOptions}
                            rules={{ required: true, message: '请选择范围' }} />
                    </Col>
                    <Col span={19}>
                        <Form.Select field='projectId' label='所属项目' style={{ width: '100%' }} showClear
                            optionList={options.projects || []}
                            placeholder='scope 为项目时必选' />
                    </Col>
                </Row>
                <Form.TextArea field='body' label='正文' rows={10} style={{ width: '100%' }}
                    placeholder='知识正文，经 MCP 工具按需读取'
                    rules={{ required: true, whitespace: true, message: '正文不能为空' }} />
            </>
        )}
        buildBody={(values) => ({
            scope: values.scope,
            projectId: values.scope === 'project' ? values.projectId : null,
            body: values.body,
        })}
    />;
}
