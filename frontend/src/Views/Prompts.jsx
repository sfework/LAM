import React from 'react';
import { withRouter, MergeSearch } from '@sfework/common';
import { Button, Form, Tag, ButtonGroup, Row, Col, Switch } from '@douyinfe/semi-ui';
import { TablePage, SearchBox, DataTable, UIFormModal, ToastUI, DeleteConfirm } from '../Common/Component';
import Net from '../Common/Net';

/**
 * 提示词页（/api/prompts，DESIGN §2.4）：
 * 多条提示词，但「生效互斥」——同一时刻最多 1 条 enabled（启用一条会自动停用其余），
 * 生效者作为系统提示注入网关。列表按名称正序。
 * 操作列：启用开关（行内切换，走 /update{enabled}，触发互斥）、编辑、删除；
 * 搜索支持关键字（名称/内容模糊）与启用状态筛选。
 * 启用仅在列表操作，编辑弹窗不重复提供（与除噪规则一致）。
 */
const enabledOptions = [
    { label: '启用', value: true },
    { label: '停用', value: false },
];

function getTableColumns(view) {
    return [
        {
            title: '启用', dataIndex: 'enabled', width: 70,
            render: (text, item) => <Switch checked={!!text} onChange={() => view.toggle(item)} />,
        },
        { title: '名称', dataIndex: 'name', width: 200, ellipsis: true },
        { title: '内容', dataIndex: 'content', ellipsis: true },
        {
            title: '更新时间', dataIndex: 'updatedAt', width: 170,
            render: (text) => text ? new Date(text).toLocaleString() : '-',
        },
        {
            title: '操作', dataIndex: 'operate', width: 138,
            render: (text, item) => (
                <ButtonGroup>
                    <Button onClick={view.edit(item)}>编辑</Button>
                    <DeleteConfirm onClick={() => view.delete(item.id)}>
                        <Button type="danger">删除</Button>
                    </DeleteConfirm>
                </ButtonGroup>
            ),
        },
    ];
}

class Prompts extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            loading: false,
            data: Net.GetPaginationModel(),
            search: Net.GetPaginationRequest(30),
        };
        this.editRef = React.createRef();
    }
    componentDidMount() { this.onLoad(); }
    onLoad = () => {
        this.setState({ loading: true });
        Net.api.prompts.list(this.state.search).then(result => {
            if (result.success) this.setState({ data: result.data, loading: false });
            else this.setState({ loading: false });
        });
    };
    onSearch = (data) => {
        var search = MergeSearch(data, this.state.search);
        this.setState({ search }, () => this.onLoad());
    };
    create = () => this.editRef.current.set({}, this.onLoad).show();
    edit = (item) => () => this.editRef.current.set(item, this.onLoad).show();
    toggle = (item) => {
        Net.api.prompts.update({ id: item.id, enabled: !item.enabled }).then(result => {
            if (result.success) {
                ToastUI.success(result.data.enabled ? '已启用（其余提示词已自动停用）' : '已停用');
                this.onLoad();
            }
        });
    };
    delete = (id) => {
        Net.api.prompts.delete({ id }).then(result => {
            if (result.success) { ToastUI.success('删除成功'); this.onLoad(); }
        });
    };
    render() {
        return <TablePage>
            <SearchBox onSearch={this.onSearch} initValues={this.state.search}>
                <Form.Input showClear field='keyword' label='关键字' style={{ width: 180 }} placeholder="名称或内容" />
                <Form.Select showClear field='enabled' label='启用状态' style={{ width: 130 }} optionList={enabledOptions} />
                <SearchBox.Submit />
                <SearchBox.Actions>
                    <Button theme='solid' type='primary' onClick={this.create}>新增</Button>
                </SearchBox.Actions>
            </SearchBox>
            <DataTable onPagination={this.onSearch} loading={this.state.loading}
                columns={getTableColumns(this)} dataSource={this.state.data} />
            <EditModal width={640} ref={this.editRef} />
        </TablePage>;
    }
}

class EditModal extends UIFormModal {
    set = (data, callback) => { this.data = { ...(data || {}) }; this.callback = callback; return this; };
    onSubmit = async (values) => {
        const body = { name: values.name, content: values.content };
        // 启用仅在列表切换；编辑不回传 enabled，避免重置原有启用状态（互斥由后端保证）。
        const result = this.data.id
            ? await Net.api.prompts.update({ id: this.data.id, ...body })
            : await Net.api.prompts.create({ ...body, enabled: !!values.enabled });
        if (result.success) {
            ToastUI.success('保存成功！');
            this.callback();
            this.hide();
        }
    };
    children() {
        return <>
            <Row gutter={16}>
                <Col span={24}>
                    <Form.Input field='name' label='名称' style={{ width: '100%' }}
                        rules={{ required: true, whitespace: true, message: '名称不能为空' }} />
                </Col>
            </Row>
            <Form.TextArea field='content' label='内容' rows={12} style={{ width: '100%' }}
                placeholder='作为系统提示注入网关的正文…'
                rules={{ required: true, whitespace: true, message: '内容不能为空' }} />
            <div style={{ color: 'var(--semi-color-text-2)', fontSize: 12, lineHeight: 1.7 }}>
                提示词「生效互斥」：同一时刻只有一条启用，启用新的一条会自动停用其余。生效者作为系统提示注入每次对话。
            </div>
        </>;
    }
}

export default withRouter(Prompts);
