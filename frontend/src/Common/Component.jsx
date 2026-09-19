import React from 'react';
import { Button, Form, Table, Pagination, Toast, Dropdown, SplitButtonGroup, Spin, Modal, Popconfirm } from '@douyinfe/semi-ui';
import { IconTreeTriangleDown } from '@douyinfe/semi-icons';
import { getGuid } from '@sfework/common';

/**
 * 通用组件套件（移植自参考实现的前端工程，class 组件写法保持一致）。
 * 与 @sfework/common 的分页模型（PaginationModel）直接对接：DataTable 吃
 * dataSource={list,totalCount,page,pageSize}，onPagination 回传 {page,pageSize}。
 */

class SearchBox extends React.Component {
    constructor(props) {
        super(props);
        this.form = React.createRef();
    }
    onSearch = (data) => {
        if (data == null) data = {};
        if (this.props.onSearch) {
            data.page = 1;
            delete data.pageSize;
            this.props.onSearch(data);
        }
    };
    reset = () => this.form.current.formApi.reset();
    getValues = () => this.form.current.formApi.getValues();
    setValues = (values) => this.form.current.formApi.setValues(values, { isOverride: true });
    render() {
        return <Form allowEmpty autoComplete={'off'} ref={this.form} className="searchBox" style={this.props.style}
            initValues={this.props.initValues} layout='horizontal' labelPosition='left' onSubmit={this.onSearch}>
            {this.props.children}
        </Form>;
    }
}
SearchBox.Submit = function (props) {
    if (!props.loading) {
        props.loading == false
    }
    return <div>
        <Button loading={props.loading} theme='solid' type="warning" htmlType="submit" block>搜索</Button>
    </div>
}
SearchBox.Actions = function (props) {
    return <div className='right'>{props.children}</div>;
};

/** 自适应表体高度：监听容器尺寸变化，设置 .semi-table-body 的 maxHeight（表头固定、表体滚动）。 */
class BaseDataTable extends React.Component {
    constructor(props) {
        super(props);
        this.state = { selectedRowKeys: [] };
        this.id = getGuid();
        this.rootRef = React.createRef();
    }
    componentDidMount() {
        var wrap = this.rootRef.current ? this.rootRef.current.parentNode : null;
        if (wrap && typeof ResizeObserver !== 'undefined') {
            this.observer = new ResizeObserver(() => this.calcHeight());
            this.observer.observe(wrap);
        } else {
            window.addEventListener('resize', this.calcHeight);
        }
        this.raf = requestAnimationFrame(this.calcHeight);
    }
    componentDidUpdate() {
        if (this.props.dataSource && this.props.dataSource.list && this.props.dataSource.list.length) this.calcHeight();
    }
    componentWillUnmount() {
        if (this.observer) { this.observer.disconnect(); this.observer = null; }
        window.removeEventListener('resize', this.calcHeight);
        if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
    }
    calcHeight = () => {
        var ele = document.getElementById(this.id);
        if (ele && ele.parentNode) {
            var fh = 30 + 40;
            for (let index = 0; index < ele.parentNode.childNodes.length; index++) {
                const element = ele.parentNode.childNodes[index];
                if (element !== ele && element.nodeType === 1) {
                    var style = window.getComputedStyle(element);
                    fh += element.clientHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
                }
            }
            var height = ele.parentNode.clientHeight - fh;
            var body = ele.querySelector('.semi-table-body');
            if (body && height > 0) body.style.maxHeight = `${height}px`;
        }
    };
    onChange = (page, pageSize) => {
        if (this.props.onPagination) this.props.onPagination({ page, pageSize });
    };
    render() {
        const ds = this.props.dataSource || { list: [], totalCount: 0, page: 1, pageSize: 30 };
        const rowSelection = {
            onChange: (selectedRowKeys, selectedRows) => {
                this.setState({ selectedRowKeys: (selectedRows || []).map(c => c.id) }, () => {
                    if (this.props.onSelect) this.props.onSelect(this.state.selectedRowKeys);
                });
            },
            selectedRowKeys: this.state.selectedRowKeys,
            fixed: this.props.columns.some(c => c.fixed === true),
        };
        return <>
            <div className="table_list" id={this.id}>
                <Table onRow={this.props.onRow} rowSelection={this.props.onSelect ? rowSelection : undefined}
                    scroll={{ y: 300, x: 600 }} rowKey={this.props.rowKey ?? 'id'} loading={this.props.loading}
                    size="small" columns={this.props.columns} dataSource={ds.list} pagination={false} />
            </div>
            {ds.list && ds.list.length > 0 && <div className="pagination">
                <Button disabled theme='outline' type='tertiary'>共计：{ds.totalCount}</Button>
                <Pagination total={ds.totalCount} currentPage={ds.page} pageSize={ds.pageSize}
                    onChange={this.onChange} showSizeChanger pageSizeOpts={[30, 50, 80, 90, 200]} />
            </div>}
        </>;
    }
}

/** 完整表格页（配 TablePage 使用，含分页）。 */
class DataTable extends BaseDataTable {
    render() { return super.render(); }
}

class TablePage extends React.Component {
    render() {
        return <div className={this.props.mode === 'simple' ? 'TablePage simple' : 'TablePage'} style={this.props.style}>{this.props.children}</div>;
    }
}

class SimpleTablePage extends React.Component {
    render() {
        var style = {};
        if (this.props.height) style.height = this.props.height;
        if (this.props.flex) { style.flex = 1; style.minHeight = 0; }
        return <div className='TablePage simple' style={style}>{this.props.children}</div>;
    }
}

/** flex 自适应列表：自带 flex 布局，父级为 flex 时伸展撑满。 */
class SimpleDataTable extends React.Component {
    render() {
        return <div style={{ width: '100%', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <DataTable {...this.props} />
        </div>;
    }
}

class ContentPage extends React.Component {
    render() {
        return <div className={this.props.loading ? 'ContentPage loading' : 'ContentPage'} style={this.props.style}>
            {this.props.loading ? <Spin size="large" /> : this.props.children}
        </div>;
    }
}

class DropdownButton extends React.Component {
    constructor(props) {
        super(props);
        this.state = { show: false };
    }
    onSwitch = () => this.setState({ show: true });
    getStyle = () => this.state.show
        ? { background: this.props.theme == 'light' ? 'var(--semi-color-fill-1)' : 'var(--semi-color-primary-hover)', padding: '8px 4px' }
        : { padding: '8px 4px' };
    render() {
        return <SplitButtonGroup>
            <Button className='ClearRound' onClick={this.props.onClick} theme={this.props.theme ?? "solid"} type={this.props.type ?? "primary"}>{this.props.text}</Button>
            <Dropdown clickToHide={true} menu={this.props.menu} onVisibleChange={this.onSwitch} trigger="click" position="bottomRight">
                <span><Button style={this.getStyle()} theme={this.props.theme ?? "solid"} type={this.props.type ?? "primary"} icon={<IconTreeTriangleDown />}></Button></span>
            </Dropdown>
        </SplitButtonGroup>;
    }
}

class UIModal extends React.Component {
    constructor(props) {
        super(props);
        this.state = { show: false, confirmLoading: false };
        this.bodyStyle = {};
        if (this.props.height) this.bodyStyle = { overflow: 'auto', height: this.props.height };
    }
    show = () => this.setState({ show: true }, this.onShow);
    onShow = () => { };
    hide = () => this.setState({ show: false }, () => { if (this.onHidden) this.onHidden(); });
    onOk = () => {
        if (this.onSubmit) {
            this.setState({ confirmLoading: true }, () => {
                Promise.resolve(this.onSubmit()).then(() => this.setState({ confirmLoading: false }));
            });
        }
    };
    getFooter() {
        if (this.props.footer === 'hide') return <></>;
        if (this.props.footer === 'hideOk') return <Button onClick={() => this.hide()}>取消</Button>;
        if (this.props.footer) return this.props.footer;
        return <>
            <Button theme='solid' type='primary' onClick={() => this.onOk()}>确认</Button>
            <Button onClick={() => this.hide()}>取消</Button>
        </>;
    }
    render() {
        return <Modal footer={this.getFooter()} fullScreen={this.props.fullScreen} bodyStyle={this.bodyStyle}
            title={this.props.title ?? '编辑'} width={this.props.width ?? 360} confirmLoading={this.state.confirmLoading}
            centered visible={this.state.show} onCancel={this.hide}>
            {this.children()}
        </Modal>;
    }
}

/** 表单弹窗基类：子类覆写 children() 与 onSubmit(values)，父组件 ref.set(data, cb).show()。 */
class UIFormModal extends React.Component {
    constructor(props) {
        super(props);
        this.state = { show: false, confirmLoading: false };
        this.bodyStyle = {};
        this.data = {};
        this.labelPosition = 'top';
        this.labelWidth = undefined;
        if (this.props.labelPosition) this.labelPosition = this.props.labelPosition;
        if (this.props.height) this.bodyStyle = { overflow: 'auto', height: this.props.height };
        if (this.props.labelWidth) this.labelWidth = this.props.labelWidth;
        this.form = React.createRef();
    }
    show = () => this.setState({ show: true }, this.onShow);
    onShow = () => { };
    hide = () => this.setState({ show: false }, () => { if (this.onHidden) this.onHidden(); });
    toLocaleString = (value) => {
        if (value instanceof Date) return value.toLocaleString();
        if (Array.isArray(value)) return value.map(v => this.toLocaleString(v));
        if (value && typeof value === 'object') {
            var r = {};
            for (var k in value) if (Object.prototype.hasOwnProperty.call(value, k)) r[k] = this.toLocaleString(value[k]);
            return r;
        }
        return value;
    };
    getFooter() {
        if (this.props.footer === 'hide') return <></>;
        if (this.props.footer === 'hideOk') return <Button onClick={() => this.hide()}>取消</Button>;
        if (this.props.footer) return this.props.footer;
        return <>
            <Button theme='solid' type='primary' loading={this.state.confirmLoading} onClick={() => this.onOk()}>确认</Button>
            <Button onClick={() => this.hide()}>取消</Button>
        </>;
    }
    onOk = () => {
        this.form.current.formApi.validate().then(values => {
            values = this.toLocaleString(values);
            if (this.onSubmit) {
                this.setState({ confirmLoading: true }, () => {
                    Promise.resolve(this.onSubmit(values)).then(() => this.setState({ confirmLoading: false }));
                });
            }
        }).catch(() => { });
    };
    render() {
        return <Modal footer={this.getFooter()} fullScreen={this.props.fullScreen} bodyStyle={this.bodyStyle}
            title={this.props.title ?? '编辑'} width={this.props.width ?? 360} confirmLoading={this.state.confirmLoading}
            centered visible={this.state.show} onCancel={this.hide}>
            <Form ref={this.form} initValues={this.data} labelPosition={this.labelPosition} labelWidth={this.labelWidth}>
                {this.children()}
            </Form>
        </Modal>;
    }
}

class DeleteConfirm extends React.Component {
    onConfirm = () => { if (this.props.onClick) this.props.onClick(); };
    render() {
        return <Popconfirm disabled={this.props.disabled} onConfirm={this.onConfirm} showArrow
            okButtonProps={{ type: 'danger' }} className='ConfirmDelete' content={this.props.content || "是否确认删除?"}>
            {this.props.children}
        </Popconfirm>;
    }
}

class OperateConfirm extends React.Component {
    onConfirm = () => { if (this.props.onClick) this.props.onClick(); };
    render() {
        return <Popconfirm onConfirm={this.onConfirm} showArrow okButtonProps={{ type: 'warning' }}
            className='ConfirmDelete' content={this.props.content || "是否确认操作?"}>
            {this.props.children}
        </Popconfirm>;
    }
}

class SpaceBetween extends React.Component {
    render() { return <div className='method-flex'>{this.props.children}</div>; }
}

const ToastUI = {
    info: (msg, duration = 3) => Toast.info({ content: msg, top: '75%', stack: true, showClose: false, duration }),
    error: (msg, duration = 3) => Toast.error({ content: msg, top: '75%', stack: true, showClose: false, duration }),
    warning: (msg, duration = 3) => Toast.warning({ content: msg, top: '75%', stack: true, showClose: false, duration }),
    success: (msg, duration = 3) => Toast.success({ content: msg, top: '75%', stack: true, showClose: false, duration }),
};

export { SearchBox, SimpleTablePage, SimpleDataTable, DataTable, ToastUI, ContentPage, TablePage, SpaceBetween, DropdownButton, UIModal, DeleteConfirm, UIFormModal, OperateConfirm };
