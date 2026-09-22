import React from 'react';
import { withRouter, MergeSearch } from '@sfework/common';
import { Button, Form, Tag, ButtonGroup, Row, Col, Switch, Typography } from '@douyinfe/semi-ui';
import { TablePage, SearchBox, DataTable, UIFormModal, ToastUI, DeleteConfirm } from '../Common/Component';
import Net from '../Common/Net';

/**
 * 除噪规则页（/api/denoise-rules，DESIGN §2.3）：
 * 规则 = 删除「开始文本」到「结束文本」之间的内容（含两端）；提取模式则保留中间内容只剥两端标记；
 * 多条按创建顺序叠加；双通道（转发/记忆）各自独立生效。列表按添加时间倒序（新增靠前）展示。
 * 操作列：启用开关（/toggle，行内直接切换）、编辑、删除；搜索支持关键字（开始/结束文本模糊）。
 * 启用仅在列表操作，编辑弹窗不重复提供。
 */
function getTableColumns(view) {
    return [
        {
            title: '启用', dataIndex: 'enabled', width: 70,
            render: (text, item) => <Switch checked={!!text} onChange={() => view.toggle(item)} />,
        },
        { title: '开始文本', dataIndex: 'startText', ellipsis: true },
        { title: '结束文本', dataIndex: 'endText', ellipsis: true },
        {
            title: '提取', dataIndex: 'extract', width: 70,
            render: (text) => text ? <Tag color='blue'>提取</Tag> : <Tag color='grey'>删除</Tag>,
        },
        {
            title: '转发通道', dataIndex: 'applyForward', width: 100,
            render: (text) => text ? <Tag color='green'>生效</Tag> : <Tag color='grey'>否</Tag>,
        },
        {
            title: '记忆通道', dataIndex: 'applyMemory', width: 100,
            render: (text) => text ? <Tag color='green'>生效</Tag> : <Tag color='grey'>否</Tag>,
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

class DenoiseRules extends React.Component {
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
        Net.api['denoise-rules'].list(this.state.search).then(result => {
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
        Net.api['denoise-rules'].toggle({ id: item.id }).then(result => {
            if (result.success) { ToastUI.success(result.data.enabled ? '已启用' : '已停用'); this.onLoad(); }
        });
    };
    delete = (id) => {
        Net.api['denoise-rules'].delete({ id }).then(result => {
            if (result.success) { ToastUI.success('删除成功'); this.onLoad(); }
        });
    };
    render() {
        return <TablePage>
            <SearchBox onSearch={this.onSearch} initValues={this.state.search}>
                <Form.Input showClear field='keyword' label='关键字' style={{ width: 180 }} placeholder="开始或结束文本" />
                <SearchBox.Submit />
                <SearchBox.Actions>
                    <Button theme='solid' type='primary' onClick={this.create}>新增</Button>
                </SearchBox.Actions>
            </SearchBox>
            <DataTable onPagination={this.onSearch} loading={this.state.loading}
                columns={getTableColumns(this)} dataSource={this.state.data} />
            <EditModal width={520} ref={this.editRef} />
        </TablePage>;
    }
}

class EditModal extends UIFormModal {
    set = (data, callback) => { this.data = { ...(data || {}) }; this.callback = callback; return this; };
    onSubmit = async (values) => {
        const body = {
            startText: values.startText,
            endText: values.endText,
            extract: !!values.extract,
            applyForward: !!values.applyForward,
            applyMemory: !!values.applyMemory,
        };
        // 启用仅在列表切换；编辑不回传 enabled，避免重置原有启用状态。
        const result = this.data.id
            ? await Net.api['denoise-rules'].update({ id: this.data.id, ...body })
            : await Net.api['denoise-rules'].create({ ...body, enabled: !!values.enabled });
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
                    <Form.Input field='startText' label='开始文本' style={{ width: '100%' }} placeholder="如 <context>"
                        rules={{ required: true, whitespace: true, message: '开始文本不能为空' }} />
                </Col>
            </Row>
            <Row gutter={16}>
                <Col span={24}>
                    <Form.Input field='endText' label='结束文本' style={{ width: '100%' }} placeholder="如 </context>；与开始文本相同则删除其所有出现"
                        rules={{ required: true, whitespace: true, message: '结束文本不能为空' }} />
                </Col>
            </Row>
            <Row gutter={16}>
                <Col span={8}>
                    <Form.Switch field='extract' label='提取' />
                </Col>
                <Col span={8}>
                    <Form.Switch field='applyForward' label='转发通道' />
                </Col>
                <Col span={8}>
                    <Form.Switch field='applyMemory' label='记忆通道' />
                </Col>
            </Row>
            <div style={{ color: 'var(--semi-color-text-2)', fontSize: 12, lineHeight: 1.7 }}>
                <div><Typography.Text strong>提取</Typography.Text>：开启后命中区间不再整段删除，而是保留中间内容、仅剥掉两端标记（如只去 &lt;context&gt;…&lt;/context&gt; 壳子）；关闭则连标记带内容一起删。开始与结束文本相同时提取无意义，仍按删除处理。</div>
                <div><Typography.Text strong>转发通道</Typography.Text>：命中的内容仅从「转发给上游模型」的请求副本中删除（影响模型看到什么）。</div>
                <div><Typography.Text strong>记忆通道</Typography.Text>：命中的内容仅从「回流至记忆库」的副本中删除（影响提取/召回存什么）。</div>
                <div>两者相互独立：只开转发则记忆仍存原文，只开记忆则模型仍看到原文。未启用时该规则在两个通道均不生效。</div>
            </div>
        </>;
    }
}

export default withRouter(DenoiseRules);
