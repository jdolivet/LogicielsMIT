BSim.MemoryView = function(container, beta) {
    var mContainer = $(container);
    var mBeta = beta;
    var mTable = null;
    var mWriteHighlight = [];
    var mReadHighlight = [];
    var mCurrentLabelRows = [];

    var beta_resize_memory = function(length) {
        var zero_word = BSim.Common.FormatWord(0);
        var word_length = Math.ceil(length / 4);

        mTable.startBatch();
        mTable.empty();
        for(var i = 0; i < length; i += 4) {
            mTable.insertRow([BSim.Common.FormatWord(i, 4), zero_word]);
        }
        mTable.endBatch();
    };

    var beta_change_word = function(address, value) {
        mTable.updateCell(address / 4, 1, BSim.Common.FormatWord(value));
    };

    var beta_bulk_change_word = function(words) {
        mTable.startBatch();
        for(var word in words) {
            beta_change_word(word, words[word]);
        }
        mTable.endBatch();
    };

    var beta_write_word = function(address) {
        handle_beta_thing(address, 'last-write', 'a', mWriteHighlight);
    };

    var beta_read_word = function(address) {
        handle_beta_thing(address, 'last-read', 'b', mReadHighlight);
    };

    var handle_beta_thing = function(address, cls, cls_prefix, list) {
        mTable.startBatch();
        var row = address / 4;
        mTable.scrollTo(row);
        for (var i = list.length - 1; i >= 0; i--) {
            mTable.removeRowClass(list[i], cls_prefix + (i));
            if(i <= 3) mTable.addRowClass(list[i], cls_prefix + (i+1));
            else mTable.removeRowClass(list[i], cls);
        }
        if(list.length > 5) list.pop();

        list.unshift(row);
        mTable.addRowClass(row, cls);
        mTable.addRowClass(row, cls_prefix + '0');
        mTable.endBatch();
    };

    var beta_bulk_read_word = function(addresses) {
        mTable.startBatch();
        _.each(addresses, beta_read_word);
        mTable.endBatch();
    };

    var beta_bulk_write_word = function(addresses) {
        mTable.startBatch();
        _.each(addresses, beta_write_word);
        mTable.endBatch();
    };

    var beta_bulk_change_labels = function(labels) {
        mTable.startBatch();
        for (var i = mCurrentLabelRows.length - 1; i >= 0; i--) {
            mCurrentLabelRows[i].updateCell(mCurrentLabelRows[i], 0, BSim.Common.FormatWord(mCurrentLabelRows[i]*4, 4));
        }
        for(var address in labels) {
            address = parseInt(address, 10);
            mTable.updateCell(address / 4, 0, labels[address]);
        }
        mTable.endBatch();
    };

    this.resize = function(height) {
        mTable.resize(height);
    };

    var initialise = function() {
        var height = mContainer.data('height') || 350;
        mTable = new BigTable(mContainer, 140, height, 22, 2);

        mBeta.on('change:word', beta_change_word);
        mBeta.on('change:bulk:word', beta_bulk_change_word);
        mBeta.on('resize:memory', beta_resize_memory);
        mBeta.on('write:word', beta_write_word);
        mBeta.on('read:word', beta_read_word);
        mBeta.on('read:bulk:word', beta_bulk_read_word);
        mBeta.on('write:bulk:word', beta_bulk_write_word);
        mBeta.on('change:bulk:labels', beta_bulk_change_labels);
    };
    initialise();
};
