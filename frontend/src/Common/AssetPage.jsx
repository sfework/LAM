import React from 'react';
import { MergeSearch } from '@sfework/common';
import { Button, Form, Switch, ButtonGroup, Row, Col } from '@douyinfe/semi-ui';
import { TablePage, SearchBox, DataTable, UIFormModal, ToastUI, DeleteConfirm } from './Component';
import Net from './Net';

/**
 * 资产 CRUD 通用页（agents / skills / knowledge 同构，DESIGN §2.4 / §2.5、决策 45/47）。
 * 参照提示词页：列表「不显示正文、显示描述」，标题列（原名称列改名「标题」），按 sortOrder 升序，
 * 启用仅在列表切换（走 update{enabled}）、编辑弹窗隐藏启用；搜索 = 关键字（标题+描述模糊）+ 启用状态。
 *
 * 启用/停用仅在列表切换（弹窗不出现启用参数）；标题、描述必填，正文（如有）必填。
 *
 * 配置驱动差异：
 *   resource      Net.api 下的资源名（'agents' | 'skills' | 'knowledge'）
 *   titleKey      标题字段名（agents/skills='name'，knowledge='title'）
 *   renderForm    (data, options)=>JSX  描述与排序之间的专属字段
 *   buildBody     (values)=>body        提交体里除标题/描述/排序外的专属字段
 *   extraColumns  描述列之后、排序列之前的额外列（如 knowledge 的 scope）
 *   loadOptions   ()=>Promise<object>   挂载时拉取的表单选项（如 knowledge 的项目列表）
 *   createDefaults 新增时的表单初值
 */
const enabledOptions = [
    { label: '启用', value: true },
    { label: '停用', value: false },
];

class AssetPage extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            loading: false,
            data: Net.GetPaginationModel(),
            search: Net.GetPaginationRequest(30),
            options: {},
        };
        this.editRef = React.createRef();
    }
    componentDidMount() {
        this.onLoad();
        if (this.props.loadOptions) {
            Promise.resolve(this.props.loadOptions()).then(o => this.setState({ options: o || {} }));
        }
    }
    api = () => Net.api[this.props.resource];
    onLoad = () => {
        this.setState({ loading: true });
        this.api().list(this.state.search).then(result => {
            if (result.success) this.setState({ data: result.data, loading: false });
            else this.setState({ loading: false });
        });
    };
    onSearch = (data) => {
        var search = MergeSearch(data, this.state.search);
        this.setState({ search }, () => this.onLoad());
    };
    create = () => this.editRef.current.set({ ...(this.props.createDefaults || {}) }, this.onLoad).show();
    edit = (item) => () => this.editRef.current.set(item, this.onLoad).show();
    toggle = (item) => {
        this.api().update({ id: item.id, enabled: !item.enabled }).then(result => {
            if (result.success) { ToastUI.success(result.data.enabled ? '已启用' : '已停用'); this.onLoad(); }
        });
    };
    delete = (id) => {
        this.api().delete({ id }).then(result => {
            if (result.success) { ToastUI.success('删除成功'); this.onLoad(); }
        });
    };
    columns = () => {
        const { titleKey } = this.props;
        const extraColumns = typeof this.props.extraColumns === 'function'
            ? this.props.extraColumns(this.state.options)
            : (this.props.extraColumns || []);
        return [
            {
                title: '启用', dataIndex: 'enabled', width: 70,
                render: (text, item) => <Switch checked={!!text} onChange={() => this.toggle(item)} />,
            },
            { title: '标题', dataIndex: titleKey, width: 200, ellipsis: true },
            { title: '描述', dataIndex: 'description', ellipsis: true },
            ...extraColumns,
            { title: '排序', dataIndex: 'sortOrder', width: 70 },
            {
                title: '操作', dataIndex: 'operate', width: 138,
                render: (text, item) => (
                    <ButtonGroup>
                        <Button onClick={this.edit(item)}>编辑</Button>
                        <DeleteConfirm onClick={() => this.delete(item.id)}>
                            <Button type="danger">删除</Button>
                        </DeleteConfirm>
                    </ButtonGroup>
                ),
            },
        ];
    };
    render() {
        return <TablePage>
            <SearchBox onSearch={this.onSearch} initValues={this.state.search}>
                <Form.Input showClear field='keyword' label='关键字' style={{ width: 180 }} placeholder="标题或描述" />
                <Form.Select showClear field='enabled' label='启用状态' style={{ width: 130 }} optionList={enabledOptions} />
                <SearchBox.Submit />
                <SearchBox.Actions>
                    <Button theme='solid' type='primary' onClick={this.create}>新增</Button>
                </SearchBox.Actions>
            </SearchBox>
            <DataTable onPagination={this.onSearch} loading={this.state.loading}
                columns={this.columns()} dataSource={this.state.data} />
            <EditModal width={640} ref={this.editRef} page={this} />
        </TablePage>;
    }
}

class EditModal extends UIFormModal {
    set = (data, callback) => { this.data = { ...(data || {}) }; this.callback = callback; return this; };
    onSubmit = async (values) => {
        const { page } = this.props;
        const { titleKey } = page.props;
        // 跨字段依赖校验钩子：返回错误信息则提示并中止提交。
        if (page.props.validate) {
            const msg = page.props.validate(values);
            if (msg) { ToastUI.warning(msg); return; }
        }
        // 标题/描述/排序统一带上；专属字段由 buildBody 补。
        const base = {
            [titleKey]: values[titleKey],
            description: values.description ?? '',
            sortOrder: values.sortOrder ?? 0,
        };
        const body = { ...base, ...page.props.buildBody(values) };
        const result = this.data.id
            ? await page.api().update({ id: this.data.id, ...body })
            : await page.api().create(body);
        if (result.success) {
            ToastUI.success('保存成功！');
            this.callback();
            this.hide();
        }
    };
    children() {
        const { page } = this.props;
        const { titleKey } = page.props;
        return <>
            <Row gutter={16}>
                <Col span={20}>
                    <Form.Input field={titleKey} label='标题' style={{ width: '100%' }}
                        rules={{ required: true, whitespace: true, message: '标题不能为空' }} />
                </Col>
                <Col span={4}>
                    <Form.InputNumber field='sortOrder' label='排序' min={0}
                        placeholder='升序' />
                </Col>
            </Row>
            <Form.Input field='description' label='描述' style={{ width: '100%' }}
                placeholder='用于注入清单展示的一句话说明'
                rules={{ required: true, whitespace: true, message: '描述不能为空' }} />
            {page.props.renderForm(this.data, page.state.options)}
        </>;
    }
}

export { AssetPage };
