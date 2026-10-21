import React from 'react';
import { withRouter, MergeSearch } from '@sfework/common';
import { Button, Form, Tag, ButtonGroup, Row, Col, Tabs, Input } from '@douyinfe/semi-ui';
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
        { title: 'Base URL', dataIndex: 'url', ellipsis: true },
        {
            title: '操作', dataIndex: 'operate', width: 168,
            render: (text, item) => {
                // 决策 77：被引用模型**可编辑**（下一调用即生效）；仅禁删除（防悬挂引用）。
                // 分类改动在编辑弹窗内禁用（后端也 400 兜底）。
                const used = !!item.inUse;
                return <ButtonGroup>
                    <Button onClick={view.edit(item)}>编辑</Button>
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

// 提供商编辑弹窗：条目=提供商，models 为提供商下可用模型清单（读取/手输，可空）。
class EditModal extends UIFormModal {
    constructor(props) {
        super(props);
        // 两种模式各自独立存态，切换页签不互污染；保存时按当前页签落对应清单：
        //   auto → autoList（/models 全量，未拉取时为空）；manual → [manualModel]。
        this.state = { ...this.state, modelMode: 'auto', autoList: [], manualModel: '', fetching: false };
    }
    set = (data, callback) => {
        this.data = { ...(data || {}) };
        this.callback = callback;
        const models = (data && data.models && data.models.length) ? data.models.map(String)
            : (data && data.model ? [String(data.model)] : []);
        // 模式以条目落库值为准（无则按清单形态推定：单模型=manual，多模型=auto）。
        const mode = (data && data.modelMode) || (models.length === 1 && models.length > 0 ? 'manual' : 'auto');
        this.setState({
            modelMode: mode,
            autoList: mode === 'auto' ? [...models] : [],
            manualModel: mode === 'manual' ? (models[0] ?? '') : '',
        });
        return this;
    };
    switchMode = (k) => this.setState({ modelMode: k });
    // 自动获取：用当前表单 url/key 调提供商 GET {url}/models（未保存条目也可试拉）；
    // 读到的全部模型即该提供商的清单。
    loadModels = () => {
        const v = this.form.current.formApi.getValues();
        if (!v.url) { ToastUI.warning('请先填写 Base URL'); return; }
        this.setState({ fetching: true });
        Net.api.models['fetch-list']({ url: v.url, key: v.key || '' }).then(result => {
            this.setState({ fetching: false });
            if (result.success && result.data) {
                this.setState({ autoList: [...new Set(result.data.models)] });
                ToastUI.success(`读取到 ${result.data.count} 个可用模型（已全部记入清单）`);
            } // 失败提示由 Net 回调统一弹出（含“不支持则转手工输入”引导）
        });
    };
    onSubmit = async (values) => {
        const isCreate = !this.data.id;
        const { modelMode, autoList, manualModel } = this.state;
        // 只保存当前模式的一种数据：auto=拉取全量清单；manual=[手输单模型]。
        const nextList = modelMode === 'manual'
            ? (String(manualModel).trim() ? [String(manualModel).trim()] : [])
            : autoList;
        const nextDefault = nextList[0] ?? '';
        // 使用中的嵌入提供商改 url 或默认模型（清单首项）→ 全量重嵌入提示（约一两个 tick 重建，期间向量检索降级）
        const embRebuild = !isCreate && this.data.inUse && this.data.category === 'embedding'
            && (values.url !== this.data.url || nextDefault !== (this.data.model || ''));
        if (embRebuild && !window.confirm('该嵌入模型正被引用，变更地址/默认模型会使全部存量向量失效并自动重嵌入（期间向量检索降级为关键词召回）。确认保存？')) {
            return;
        }
        const payload = { ...values, models: nextList, modelMode };
        const result = isCreate
            ? await Net.api.models.create(payload)
            : await Net.api.models.update({ id: this.data.id, ...payload });
        if (result.success) {
            ToastUI.success(embRebuild ? '保存成功，向量重建已触发' : '保存成功！');
            this.callback();
            this.hide();
        }
    };
    children() {
        // 编辑时分类恒禁用（决策 77 收紧）：改类等于换提供商，应走"新建 + 重绑"；后端同步 400 兜底。
        const lockCategory = !!this.data.id;
        // 外层 UIFormModal 的 <Form initValues={this.data}> 已带 models 清单字段进表单。
        return <>
            <Row gutter={16}>
                <Col span={12}>
                    <Form.Select field='category' label='分类' style={{ width: '100%' }} optionList={categoryOptions}
                        disabled={lockCategory}
                        extraText={lockCategory ? '编辑不可修改分类，如需换分类请新建模型' : undefined}
                        rules={{ required: true, message: '请选择分类' }} />
                </Col>
                <Col span={12}>
                    <Form.Input field='name' label='提供商名称' style={{ width: '100%' }} rules={{ required: true, message: '名称不能为空' }} />
                </Col>
            </Row>
            <Form.Slot label='模型'>
                <Tabs activeKey={this.state.modelMode} onChange={this.switchMode}>
                    <Tabs.TabPane tab='自动获取' itemKey='auto'>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <Input readonly style={{ flex: 1 }}
                                value={this.state.autoList.length ? `已获取 ${this.state.autoList.length} 个可用模型` : ''}
                                placeholder="点右侧「读取模型」拉取，读到的全部模型即清单" />
                            <Button theme='borderless' type='primary' loading={this.state.fetching}
                                onClick={this.loadModels}>读取模型</Button>
                        </div>
                    </Tabs.TabPane>
                    <Tabs.TabPane tab='手工输入' itemKey='manual'>
                        <Input value={this.state.manualModel} style={{ width: '100%' }}
                            placeholder="该提供商不支持 /models，手输它唯一支持的模型名"
                            onChange={(v) => this.setState({ manualModel: v })} />
                    </Tabs.TabPane>
                </Tabs>
            </Form.Slot>
            <Form.Input field='url' label='Base URL' style={{ width: '100%' }} placeholder="如 https://.../v1" rules={{ required: true, message: 'Base URL 不能为空' }} />
            <Form.Input mode='password' field='key' label='密钥' style={{ width: '100%' }}
                rules={{ required: true, whitespace: true, message: '密钥不能为空' }} />
        </>;
    }
}

export default withRouter(Models);
