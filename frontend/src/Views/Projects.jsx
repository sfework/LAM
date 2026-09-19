import React from 'react';
import { withRouter, MergeSearch } from '@sfework/common';
import { Button, Form, Tag, ButtonGroup, Row, Col } from '@douyinfe/semi-ui';
import { TablePage, SearchBox, DataTable, UIFormModal, DeleteConfirm, ToastUI } from '../Common/Component';
import Net from '../Common/Net';

/**
 * 项目页（/api/projects）：项目由网关请求自动登记，无手工新增。
 * 列：名称 / 路径 / 最近活跃 / 操作（编辑改名或换目录、软删）。软删后再次请求该路径会自动恢复。
 * 换目录：记忆按 project_id 保留；CodeGraph 索引（相对旧根失效）由后端停旧监听并在新根重建。
 */
function getTableColumns(view) {
    return [
        { title: '名称', dataIndex: 'name', width: 220, ellipsis: true },
        { title: '路径', dataIndex: 'path' },
        {
            title: '最近活跃', dataIndex: 'lastActiveAt', width: 180,
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

class Projects extends React.Component {
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
        Net.api.projects.list(this.state.search).then(result => {
            if (result.success) this.setState({ data: result.data, loading: false });
            else this.setState({ loading: false });
        });
    };
    onSearch = (data) => {
        var search = MergeSearch(data, this.state.search);
        this.setState({ search }, () => this.onLoad());
    };
    edit = (item) => () => this.editRef.current.set(item, this.onLoad).show();
    delete = (id) => {
        Net.api.projects.delete({ id }).then(result => {
            if (result.success) {
                ToastUI.success('已删除（下次该路径请求会自动恢复）');
                this.onLoad();
            }
        });
    };
    render() {
        return <TablePage>
            <SearchBox onSearch={this.onSearch} initValues={this.state.search}>
                <Form.Input showClear={true} field='keyword' label='关键字' style={{ width: 180 }} placeholder="名称或路径" />
                <SearchBox.Submit />
            </SearchBox>
            <DataTable onPagination={this.onSearch} loading={this.state.loading}
                columns={getTableColumns(this)} dataSource={this.state.data} />
            <EditModal width={480} ref={this.editRef} />
        </TablePage>;
    }
}

class EditModal extends UIFormModal {
    set = (data, callback) => { this.data = { ...(data || {}) }; this.callback = callback; return this; };
    onSubmit = async (values) => {
        const result = await Net.api.projects.update({ id: this.data.id, ...values });
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
                    <Form.Input field='name' label='名称' style={{ width: '100%' }} rules={{ required: true, message: '名称不能为空' }} />
                </Col>
            </Row>
            <Row gutter={16}>
                <Col span={24}>
                    <Form.Input field='path' label='目录' style={{ width: '100%' }}
                        extraText='项目所在绝对路径（如 D:\Work\Proj）。更换目录时记忆保留，代码图索引将在新目录自动重建。'
                        rules={{ required: true, message: '目录不能为空' }} />
                </Col>
            </Row>
        </>;
    }
}

export default withRouter(Projects);
