import React from 'react';
import { withRouter, MergeSearch } from '@sfework/common';
import { Button, Form, Tag, ButtonGroup, Row, Col, Tooltip } from '@douyinfe/semi-ui';
import { TablePage, SearchBox, DataTable, UIFormModal, ToastUI, DeleteConfirm } from '../Common/Component';
import Net from '../Common/Net';

const categoryOptions = [
    { label: 'LLM', value: 'llm' },
    { label: 'Embedding', value: 'embedding' },
];

function getTableColumns(view) {
    return [
        {
            title: '分类', dataIndex: 'category', width: 110,
            render: (text) => text === 'embedding'
                ? <Tag color='light-blue'>Embedding</Tag>
                : <Tag color='purple'>LLM</Tag>,
        },
        { title: '名称', dataIndex: 'name', width: 180, ellipsis: true },
        { title: '模型', dataIndex: 'model', width: 220, ellipsis: true },
        { title: 'Base URL', dataIndex: 'url', ellipsis: true },
        {
            title: '操作', dataIndex: 'operate', width: 168,
            render: (text, item) => {
                // 被设置引用的模型：禁编辑/禁删除（后端也会 400 兜底）。
                const used = !!item.inUse;
                return <ButtonGroup>
                    <Button disabled={used} onClick={view.edit(item)}>编辑</Button>
                    <DeleteConfirm disabled={used} onClick={() => view.delete(item.id)}>
                        <Button type="danger" disabled={used}>删除</Button>
                    </DeleteConfirm>
                </ButtonGroup>;
            },
        },
    ];
}

class Models extends React.Component {
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
        Net.api.models.list(this.state.search).then(result => {
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
    delete = (id) => {
        Net.api.models.delete({ id }).then(result => {
            if (result.success) { ToastUI.success('删除成功'); this.onLoad(); }
        });
    };
    render() {
        return <TablePage>
            <SearchBox onSearch={this.onSearch} initValues={this.state.search}>
                <Form.Input showClear field='keyword' label='关键字' style={{ width: 180 }} placeholder="名称或模型名" />
                <Form.Select showClear field='category' label='分类' style={{ width: 160 }} optionList={categoryOptions} />
                <SearchBox.Submit />
                <SearchBox.Actions>
                    <Button theme='solid' type='primary' onClick={this.create}>新增</Button>
                </SearchBox.Actions>
            </SearchBox>
            <DataTable onPagination={this.onSearch} loading={this.state.loading}
                columns={getTableColumns(this)} dataSource={this.state.data} />
            <EditModal width={460} ref={this.editRef} />
        </TablePage>;
    }
}

class EditModal extends UIFormModal {
    set = (data, callback) => { this.data = { ...(data || {}) }; this.callback = callback; return this; };
    onSubmit = async (values) => {
        const isCreate = !this.data.id;
        const result = isCreate
            ? await Net.api.models.create(values)
            : await Net.api.models.update({ id: this.data.id, ...values });
        if (result.success) {
            ToastUI.success('保存成功！');
            this.callback();
            this.hide();
        }
    };
    children() {
        return <>
            <Row gutter={16}>
                <Col span={12}>
                    <Form.Select field='category' label='分类' style={{ width: '100%' }} optionList={categoryOptions}
                        rules={{ required: true, message: '请选择分类' }} />
                </Col>
                <Col span={12}>
                    <Form.Input field='name' label='名称' style={{ width: '100%' }} rules={{ required: true, message: '名称不能为空' }} />
                </Col>
            </Row>
            <Form.Input field='model' label='模型名' style={{ width: '100%' }} rules={{ required: true, message: '模型名不能为空' }} />
            <Form.Input field='url' label='Base URL' style={{ width: '100%' }} placeholder="如 https://.../v1" rules={{ required: true, message: 'Base URL 不能为空' }} />
            <Form.Input mode='password' field='key' label='密钥' style={{ width: '100%' }}
                rules={{ required: true, whitespace: true, message: '密钥不能为空' }} />
        </>;
    }
}

export default withRouter(Models);
