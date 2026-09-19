import React from 'react';
import { withRouter, MergeSearch } from '@sfework/common';
import { Select, Tabs, TabPane, Form, Tag, Button, Typography, TextArea, ButtonGroup } from '@douyinfe/semi-ui';
import { TablePage, SearchBox, DataTable, UIFormModal, UIModal, ToastUI, DeleteConfirm } from '../Common/Component';
import Net from '../Common/Net';

/**
 * 记忆库页（/api/memories，DESIGN §2.7、决策 55）：
 * 筛选区 = 项目下拉（默认最后活跃的项目）；下方 3 页签：对话-L0 / 记忆-L1 / 画像-L2。
 * 页签内容按当前 tabKey 条件渲染：切到哪个页签才挂载哪个，离开即卸载 → 每次切换都重新加载该页签数据。
 * 切换项目 → 回到第一个页签并加载其内容。
 *  - L0：分页列表，内容/角色检索，时间倒序，查看（只读弹窗：角色/时间/全文）+ 删除（物理删 + 移出 FTS）。
 *  - L1：分页列表，内容检索，生成时间倒序，可编辑（正文，sha256 比对：变了才重写 FTS/失效向量待补嵌入）、可删除。
 *  - L2：textarea 画像全文，保存按钮（sha256 比对：变了才写库 version 自增；L2 不参与检索故不向量化）。
 * 内容列直接输出文本 + ellipsis（不再用 Tooltip 悬浮全文），完整内容经「查看」弹窗阅读。
 */
/** 毫秒时间戳 → 本地时间串（固定本地时区，与日志页一致）。 */
function formatTime(ms) {
    return ms ? new Date(ms).toLocaleString() : '-';
}

/** L1 条目类型（kind，后端英文枚举）→ 中文名。未知值原样显示。 */
const L1_KIND_LABELS = {
    persona: '偏好画像',
    episodic: '事件记录',
    instruction: '行为指令',
    fact: '事实',
    method: '方法经验',
    artifact: '资产链接',
};
function kindLabel(kind) {
    return L1_KIND_LABELS[kind] || kind || '-';
}

class Memories extends React.Component {
    constructor(props) {
        super(props);
        this.state = { projects: [], projectId: null, tabKey: 'l0' };
    }
    componentDidMount() {
        Net.api.projects.list({ page: 1, pageSize: 1000 }).then(result => {
            if (!result.success) return;
            const projects = result.data.list;
            const latest = projects.slice().sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))[0];
            this.setState({ projects, projectId: latest ? latest.id : null });
        });
    }
    onProjectChange = (v) => {
        // 切换项目：回到第一个页签，页签子组件按 projectId 重新挂载并加载。
        this.setState({ projectId: v, tabKey: 'l0' });
    };
    onTabChange = (k) => this.setState({ tabKey: k });
    render() {
        const { projects, projectId, tabKey } = this.state;
        const none = <Typography.Text type='tertiary'>暂无项目，先在网关发起一次请求登记项目</Typography.Text>;
        // 只渲染当前激活页签的内容：切换即卸载旧页签、重新挂载新页签，其 componentDidMount 会重新拉数据。
        const pane = !projectId ? none
            : tabKey === 'l0' ? <L0Tab key={`l0-${projectId}`} projectId={projectId} />
            : tabKey === 'l1' ? <L1Tab key={`l1-${projectId}`} projectId={projectId} />
            : <L2Tab key={`l2-${projectId}`} projectId={projectId} />;
        return <div className='memPage'>
            {/* TabPane 的键属性是 itemKey（非 tabKey）；内容按 tabKey 条件渲染（切页签即重载），切换项目以 key 强制重挂载并回到第一个页签。
                项目选择放在 Tabs 的 tabBarExtraContent（页签栏右侧）。 */}
            <Tabs activeKey={tabKey} onChange={this.onTabChange} type='button' className='memTabs'
                tabBarExtraContent={
                    <div>
                        <Typography.Text style={{ marginRight: 8 }}>项目</Typography.Text>
                        <Select style={{ width: 300 }} optionList={projects.map(p => ({ label: p.name, value: p.id }))}
                            value={projectId ?? undefined} onChange={this.onProjectChange} placeholder='选择项目' />
                    </div>
                }>
                <TabPane itemKey='l0' tab='对话-L0'>{tabKey === 'l0' ? pane : null}</TabPane>
                <TabPane itemKey='l1' tab='记忆-L1'>{tabKey === 'l1' ? pane : null}</TabPane>
                <TabPane itemKey='l2' tab='画像-L2'>{tabKey === 'l2' ? pane : null}</TabPane>
            </Tabs>
        </div>;
    }
}

/** 对话-L0：内容/角色检索，时间倒序，查看（只读弹窗）/删除。 */
class L0Tab extends React.Component {
    constructor(props) {
        super(props);
        this.state = { loading: false, data: Net.GetPaginationModel(), search: Net.GetPaginationRequest(30), viewTitle: '对话内容' };
        this.viewRef = React.createRef();
    }
    componentDidMount() { this.onLoad(); }
    onLoad = () => {
        this.setState({ loading: true });
        Net.api.memories['l0-list']({ ...this.state.search, project_id: this.props.projectId }).then(result => {
            if (result.success) this.setState({ data: result.data, loading: false });
            else this.setState({ loading: false });
        });
    };
    onSearch = (data) => { const search = MergeSearch(data, this.state.search); this.setState({ search }, () => this.onLoad()); };
    view = (item) => () => {
        // UIModal 标题取自 props，弹窗内容随行走父组件 state + ref 传数据。
        this.setState({ viewTitle: `${item.role === 'user' ? '用户' : '助手'} · ${formatTime(item.createdAt)}` },
            () => this.viewRef.current.set(item).show());
    };
    delete = (id) => {
        Net.api.memories['l0-delete']({ id }).then(result => {
            if (result.success) { ToastUI.success('删除成功'); this.onLoad(); }
        });
    };
    columns = () => [
        {
            title: '角色', dataIndex: 'role', width: 90,
            render: (text) => text === 'user' ? <Tag color='cyan'>用户</Tag> : <Tag color='green'>助手</Tag>,
        },
        { title: '内容', dataIndex: 'content', ellipsis: true },
        { title: '时间', dataIndex: 'createdAt', width: 180, render: (text) => formatTime(text) },
        {
            title: '操作', dataIndex: 'operate', width: 138,
            render: (text, item) => (
                <ButtonGroup>
                    <Button onClick={this.view(item)}>查看</Button>
                    <DeleteConfirm onClick={() => this.delete(item.id)}><Button type='danger'>删除</Button></DeleteConfirm>
                </ButtonGroup>
            ),
        },
    ];
    render() {
        return <TablePage style={{ padding: 0 }}>
            <SearchBox onSearch={this.onSearch} initValues={this.state.search}>
                <Form.Input showClear field='keyword' label='关键字' style={{ width: 200 }} placeholder='消息内容' />
                <Form.Select showClear field='role' label='角色' style={{ width: 130 }}
                    optionList={[{ label: '用户', value: 'user' }, { label: '助手', value: 'assistant' }]} />
                <SearchBox.Submit />
            </SearchBox>
            <DataTable onPagination={this.onSearch} loading={this.state.loading} columns={this.columns()} dataSource={this.state.data} />
            <L0ViewModal ref={this.viewRef} width={680} height={460} footer='hideOk' title={this.state.viewTitle} />
        </TablePage>;
    }
}

/** L0 查看弹窗：只读展示消息全文（含角色/时间），不可编辑，仅「关闭」。 */
class L0ViewModal extends UIModal {
    constructor(props) {
        super(props);
        this.data = {};
    }
    set = (data) => { this.data = { ...(data || {}) }; return this; };
    children() {
        const { role, content, createdAt } = this.data;
        return <>
            <div style={{ marginBottom: 8 }}>
                {role === 'user'
                    ? <Tag color='cyan'>用户</Tag>
                    : <Tag color='green'>助手</Tag>}
                <Typography.Text type='tertiary' size='small' style={{ marginLeft: 8 }}>
                    {formatTime(createdAt)}
                </Typography.Text>
            </div>
            <pre style={{
                margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                fontFamily: 'var(--semi-font-family-code, Consolas, monospace)', fontSize: 13, lineHeight: 1.7,
            }}>{content || '（空）'}</pre>
        </>;
    }
}

/** 记忆-L1：内容检索，时间倒序，编辑（sha 比对）/删除。 */
class L1Tab extends React.Component {
    constructor(props) {
        super(props);
        this.state = { loading: false, data: Net.GetPaginationModel(), search: Net.GetPaginationRequest(30) };
        this.editRef = React.createRef();
    }
    componentDidMount() { this.onLoad(); }
    onLoad = () => {
        this.setState({ loading: true });
        Net.api.memories.list({ ...this.state.search, project_id: this.props.projectId }).then(result => {
            if (result.success) this.setState({ data: result.data, loading: false });
            else this.setState({ loading: false });
        });
    };
    onSearch = (data) => { const search = MergeSearch(data, this.state.search); this.setState({ search }, () => this.onLoad()); };
    edit = (item) => () => this.editRef.current.set(item, this.onLoad).show();
    delete = (id) => {
        Net.api.memories.delete({ id }).then(result => {
            if (result.success) { ToastUI.success('删除成功'); this.onLoad(); }
        });
    };
    columns = () => [
        { title: '类型', dataIndex: 'kind', width: 110, render: (text) => <Tag color='light-blue'>{kindLabel(text)}</Tag> },
        { title: '内容', dataIndex: 'content', ellipsis: true },
        { title: '优先级', dataIndex: 'priority', width: 80 },
        { title: '生成时间', dataIndex: 'createdAt', width: 180, render: (text) => formatTime(text) },
        {
            title: '操作', dataIndex: 'operate', width: 138,
            render: (text, item) => (
                <ButtonGroup>
                    <Button onClick={this.edit(item)}>编辑</Button>
                    <DeleteConfirm onClick={() => this.delete(item.id)}><Button type='danger'>删除</Button></DeleteConfirm>
                </ButtonGroup>
            ),
        },
    ];
    render() {
        return <TablePage style={{ padding: 0 }}>
            <SearchBox onSearch={this.onSearch} initValues={this.state.search}>
                <Form.Input showClear field='keyword' label='关键字' style={{ width: 220 }} placeholder='记忆内容' />
                <SearchBox.Submit />
            </SearchBox>
            <DataTable onPagination={this.onSearch} loading={this.state.loading} columns={this.columns()} dataSource={this.state.data} />
            <L1EditModal ref={this.editRef} width={620} />
        </TablePage>;
    }
}

/** L1 编辑弹窗：仅正文；带 sha256 做乐观并发 + 变更判定。 */
class L1EditModal extends UIFormModal {
    set = (data, callback) => { this.data = { ...data }; this.callback = callback; return this; };
    onSubmit = async (values) => {
        const result = await Net.api.memories.update({ id: this.data.id, content: values.content, sha256: this.data.sha256 });
        if (result.success) {
            ToastUI.success(result.data.changed ? '已保存并更新索引' : '内容未变化');
            this.callback();
            this.hide();
        }
    };
    children() {
        return <>
            <div style={{ marginBottom: 8 }}>
                <Tag color='light-blue'>{kindLabel(this.data.kind)}</Tag>
                <Typography.Text type='tertiary' size='small' style={{ marginLeft: 8 }}>sha256：{(this.data.sha256 || '').slice(0, 16)}…</Typography.Text>
            </div>
            <Form.TextArea field='content' label='正文' rows={10} style={{ width: '100%' }}
                rules={{ required: true, whitespace: true, message: '正文不能为空' }} />
        </>;
    }
}

/** 画像-L2：textarea + 保存（sha 比对）。 */
class L2Tab extends React.Component {
    constructor(props) {
        super(props);
        this.state = { loading: false, saving: false, content: '', sha256: '', version: 0 };
    }
    componentDidMount() { this.onLoad(); }
    onLoad = () => {
        this.setState({ loading: true });
        Net.api.memories.profile({ project_id: this.props.projectId }).then(result => {
            if (result.success) this.setState({ content: result.data.content, sha256: result.data.sha256, version: result.data.version ?? 0, loading: false });
            else this.setState({ loading: false });
        });
    };
    save = () => {
        this.setState({ saving: true });
        Net.api.memories['save-profile']({ project_id: this.props.projectId, content: this.state.content, sha256: this.state.sha256 }).then(result => {
            this.setState({ saving: false });
            if (result.success) {
                ToastUI.success(result.data.changed ? '画像已保存' : '画像未变化');
                this.onLoad();
            }
        });
    };
    render() {
        const { content, loading, saving, version } = this.state;
        return <div className='memL2'>
            <Button theme='solid' type='primary' loading={saving} disabled={loading} onClick={this.save}>保存</Button>
            <TextArea value={content} onChange={v => this.setState({ content: v })}
                disabled={loading} placeholder='（暂无画像，可点击「设置」页或本按钮保存以创建，或用 /rebuild-profile 由记忆凝练生成）'
                autosize={{ minRows: 18, maxRows: 40 }} style={{height: '100%', width: '100%', fontFamily: 'var(--semi-font-family-code, Consolas, monospace)', fontSize: 13 }} />
        </div>;
    }
}

export default withRouter(Memories);
