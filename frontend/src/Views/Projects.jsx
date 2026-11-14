import React from 'react';
import { withRouter, MergeSearch } from '@sfework/common';
import { Button, Form, Tag, ButtonGroup, Row, Col, SideSheet } from '@douyinfe/semi-ui';
import { TablePage, SearchBox, DataTable, UIFormModal, DeleteConfirm, ToastUI } from '../Common/Component';
import Net from '../Common/Net';

/**
 * 项目页（/api/projects）：项目由网关请求自动登记，无手工新增。
 * 列：名称 / 路径 / 最近活跃 / 操作（编辑改名或换目录、数据库连接、软删）。
 * 软删后再次请求该路径会自动恢复；换目录时对话/记忆/画像按 project_id 保留。
 * 数据库连接（新功能 1）：每项目多条连接平等可用（无启停状态），连接名项目内唯一，按名选用。
 */

const DB_TYPES = [
    { value: 'sqlite', label: 'SQLite' },
    { value: 'mysql', label: 'MySQL' },
    { value: 'postgresql', label: 'PostgreSQL' },
    { value: 'sqlserver', label: 'SQL Server' },
];

const CONN_HINTS = {
    sqlite: '数据库文件绝对路径（如 e:/data/app.db），或 Data Source=... 形式',
    mysql: 'mysql://host:3306/dbname，或 Server=...;Database=...;Uid=...;Pwd=...;',
    postgresql: 'postgres://host:5432/dbname，或 keyword=value 形式',
    sqlserver: 'Server=host,1433;Database=db;User Id=sa;Password=...;TrustServerCertificate=True;',
};

function getTableColumns(view) {
    return [
        { title: '名称', dataIndex: 'name', width: 220, ellipsis: true },
        { title: '路径', dataIndex: 'path' },
        {
            title: '最近活跃', dataIndex: 'lastActiveAt', width: 180,
            render: (text) => text ? new Date(text).toLocaleString() : '-',
        },
        {
            title: '操作', dataIndex: 'operate', width: 210,
            render: (text, item) => (
                <ButtonGroup>
                    <Button onClick={view.edit(item)}>编辑</Button>
                    <Button onClick={view.conns(item)}>连接</Button>
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
            connProject: null,
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
    conns = (item) => () => this.setState({ connProject: item });
    closeConns = () => this.setState({ connProject: null });
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
            <ConnDrawer project={this.state.connProject} onClose={this.closeConns} />
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
                        extraText='项目所在绝对路径（如 D:\Work\Proj）。更换目录时对话/记忆/画像按项目保留。'
                        rules={{ required: true, message: '目录不能为空' }} />
                </Col>
            </Row>
        </>;
    }
}

/** 数据库连接抽屉（新功能 1）：列表 + 新增/编辑/删除（连接无启停状态，按名选用）。 */
class ConnDrawer extends React.Component {
    constructor(props) {
        super(props);
        this.state = { loading: false, rows: [] };
        this.saveRef = React.createRef();
    }
    componentDidUpdate(prev) {
        if (prev.project !== this.props.project && this.props.project) this.onLoad();
    }
    onLoad = () => {
        const p = this.props.project;
        if (!p) return;
        this.setState({ loading: true });
        Net.api.projects['conn-list']({ project_id: p.id }).then(result => {
            if (result.success) this.setState({ rows: result.data || [], loading: false });
            else this.setState({ loading: false });
        });
    };
    edit = (row) => () => this.saveRef.current.set(row, this.props.project, this.onLoad).show();
    create = () => this.saveRef.current.set(null, this.props.project, this.onLoad).show();
    delete = (id) => {
        Net.api.projects['conn-delete']({ id }).then(result => {
            if (result.success) { ToastUI.success('已删除'); this.onLoad(); }
        });
    };
    render() {
        const p = this.props.project;
        const page = { list: this.state.rows, totalCount: this.state.rows.length, page: 1, pageSize: 100, totalPage: 1, hasNextPage: false, hasPreviousPage: false };
        return <SideSheet title={`数据库连接 - ${p ? p.name : ''}`} visible={!!p} onCancel={this.props.onClose} width={720}>
            <div style={{ marginBottom: 12 }}>
                <Button type="primary" onClick={this.create}>新增连接</Button>
                <span style={{ marginLeft: 12, color: 'var(--semi-color-text-2)' }}>
                    多条连接平等可用；AI 先用 MCP list_db_connections 查询连接名，再以连接名调用 sql_query。
                </span>
            </div>
            <DataTable loading={this.state.loading} columns={connColumns(this)} dataSource={page} />
            <ConnSaveModal width={560} ref={this.saveRef} />
        </SideSheet>;
    }
}

function connColumns(view) {
    return [
        { title: '连接名', dataIndex: 'name', width: 140, ellipsis: true },
        { title: '类型', dataIndex: 'dbType', width: 110, render: (t) => <Tag>{t}</Tag> },
        { title: '连接字符串', dataIndex: 'connectionString', ellipsis: true },
        {
            title: '操作', dataIndex: 'operate', width: 170,
            render: (t, row) => (
                <span style={{ whiteSpace: 'nowrap' }}>
                    <ButtonGroup>
                        <Button onClick={view.edit(row)}>编辑</Button>
                        <DeleteConfirm onClick={() => view.delete(row.id)}>
                            <Button type="danger">删除</Button>
                        </DeleteConfirm>
                    </ButtonGroup>
                </span>
            ),
        },
    ];
}

/** 连接新增/编辑弹窗：id 空=新增，非空=编辑（保存后端统一 conn-save）。 */
class ConnSaveModal extends UIFormModal {
    set = (data, project, callback) => { this.data = { ...(data || {}) }; this.project = project; this.callback = callback; return this; };
    onSubmit = async (values) => {
        const result = await Net.api.projects['conn-save']({
            id: this.data.id || undefined,
            project_id: this.project.id,
            name: values.name,
            db_type: values.dbType,
            connection_string: values.connectionString,
        });
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
                    <Form.Input field='name' label='连接名' style={{ width: '100%' }} rules={{ required: true, message: '连接名不能为空' }} />
                </Col>
                <Col span={12}>
                    <Form.Select field='dbType' label='数据库类型' style={{ width: '100%' }} optionList={DB_TYPES}
                        rules={{ required: true, message: '请选择数据库类型' }} />
                </Col>
            </Row>
            <Row gutter={16}>
                <Col span={24}>
                    <Form.TextArea field='connectionString' label='连接字符串' style={{ width: '100%' }} rows={3}
                        extraText={CONN_HINTS[this.data.dbType] || '按所选类型的格式填写'}
                        rules={{ required: true, message: '连接字符串不能为空' }} />
                </Col>
            </Row>
        </>;
    }
}

export default withRouter(Projects);
