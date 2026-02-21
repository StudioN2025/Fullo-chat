// Appwrite DB Wrapper - для обеспечения совместимости с Firebase Firestore
window.db = (function() {
    // Полифилл для FieldValue
    const FieldValue = {
        serverTimestamp: function() {
            return new Date();
        },
        increment: function(value) {
            // Appwrite не поддерживает increment напрямую, возвращаем значение для последующей обработки
            return { increment: value };
        },
        arrayUnion: function(...elements) {
            // Для Appwrite будем обрабатывать массивы по-другому
            return { arrayUnion: elements };
        },
        arrayRemove: function(...elements) {
            // Для Appwrite будем обрабатывать массивы по-другому
            return { arrayRemove: elements };
        }
    };

    // Класс DocumentReference
    class DocumentReference {
        constructor(collectionRef, docId) {
            this.collectionRef = collectionRef;
            this.docId = docId;
            this.path = `${collectionRef.path}/${docId}`;
        }

        async get() {
            try {
                const document = await AppwriteClient.databases.getDocument(
                    AppwriteClient.databaseId,
                    this.collectionRef.collectionId,
                    this.docId
                );
                
                return new DocumentSnapshot(document.$id, true, document);
            } catch (error) {
                if (error.toString().includes('404')) {
                    return new DocumentSnapshot(this.docId, false, null);
                }
                throw error;
            }
        }

        async set(data, options = {}) {
            if (options.merge) {
                return this.update(data);
            } else {
                // Для Appwrite нужно будет использовать update или создание документа
                try {
                    const result = await AppwriteClient.databases.updateDocument(
                        AppwriteClient.databaseId,
                        this.collectionRef.collectionId,
                        this.docId,
                        this._prepareData(data)
                    );
                    return { id: result.$id, ...result };
                } catch (error) {
                    // Если документ не существует, создаем его
                    if (error.toString().includes('404')) {
                        return await AppwriteClient.databases.createDocument(
                            AppwriteClient.databaseId,
                            this.collectionRef.collectionId,
                            this.docId,
                            this._prepareData(data),
                            undefined,
                            ['*'],
                            ['*']
                        );
                    }
                    throw error;
                }
            }
        }

        async update(data) {
            const preparedData = this._prepareData(data);
            return await AppwriteClient.databases.updateDocument(
                AppwriteClient.databaseId,
                this.collectionRef.collectionId,
                this.docId,
                preparedData
            );
        }

        async delete() {
            return await AppwriteClient.databases.deleteDocument(
                AppwriteClient.databaseId,
                this.collectionRef.collectionId,
                this.docId
            );
        }

        _prepareData(data) {
            const processedData = {};
            for (const [key, value] of Object.entries(data)) {
                if (value && typeof value === 'object' && value.increment !== undefined) {
                    // Обработка increment операций
                    processedData[key] = value.increment;
                } else if (value && typeof value === 'object' && value.arrayUnion !== undefined) {
                    // Для arrayUnion нужно реализовать специальную логику
                    processedData[key] = value.arrayUnion;
                } else if (value && typeof value === 'object' && value.arrayRemove !== undefined) {
                    // Для arrayRemove нужно реализовать специальную логику
                    processedData[key] = value.arrayRemove;
                } else if (value instanceof Date) {
                    processedData[key] = value.toISOString();
                } else {
                    processedData[key] = value;
                }
            }
            return processedData;
        }

        collection(collectionId) {
            return new CollectionReference(`${this.path}/${collectionId}`, collectionId);
        }
    }

    // Класс CollectionReference
    class CollectionReference {
        constructor(path, collectionId) {
            this.path = path;
            this.collectionId = collectionId;
        }

        async add(data) {
            const preparedData = this._prepareData(data);
            const result = await AppwriteClient.databases.createDocument(
                AppwriteClient.databaseId,
                this.collectionId,
                'unique()',
                preparedData,
                undefined,
                ['*'],
                ['*']
            );
            return new DocumentReference(this, result.$id);
        }

        async get() {
            const documents = await AppwriteClient.databases.listDocuments(
                AppwriteClient.databaseId,
                this.collectionId
            );
            return new QuerySnapshot(documents.documents.map(doc => new DocumentSnapshot(doc.$id, true, doc)));
        }

        doc(docId) {
            return new DocumentReference(this, docId);
        }

        where(field, operator, value) {
            // Реализация фильтрации
            return new Query(this, { field, operator, value });
        }

        orderBy(field, direction = 'DESC') {
            // Реализация сортировки
            return new Query(this, null, { field, direction });
        }

        limit(limit) {
            // Реализация ограничения количества результатов
            return new Query(this, null, null, limit);
        }

        onSnapshot(callback) {
            // Подписка на изменения коллекции через Appwrite Realtime
            const channel = `databases.${AppwriteClient.databaseId}.collections.${this.collectionId}.documents`;
            return AppwriteClient.realtime.subscribe(channel, response => {
                // Преобразуем ответ Appwrite в формат Firestore
                const document = new DocumentSnapshot(response.payload.$id, true, response.payload);
                const change = {
                    type: response.events.some(e => e.includes('create')) ? 'added' :
                          response.events.some(e => e.includes('update')) ? 'modified' : 'removed',
                    doc: document
                };
                
                // Создаем объект, похожий на snapshot из Firestore
                const snapshot = {
                    docChanges: () => [change],
                    forEach: (fn) => fn(document)
                };
                
                callback(snapshot);
            });
        }

        _prepareData(data) {
            const processedData = {};
            for (const [key, value] of Object.entries(data)) {
                if (value && typeof value === 'object' && value.increment !== undefined) {
                    processedData[key] = value.increment;
                } else if (value && typeof value === 'object' && value.arrayUnion !== undefined) {
                    processedData[key] = value.arrayUnion;
                } else if (value && typeof value === 'object' && value.arrayRemove !== undefined) {
                    processedData[key] = value.arrayRemove;
                } else if (value instanceof Date) {
                    processedData[key] = value.toISOString();
                } else {
                    processedData[key] = value;
                }
            }
            return processedData;
        }
    }

    // Класс Query
    class Query {
        constructor(collectionRef, filter = null, order = null, limitVal = null) {
            this.collectionRef = collectionRef;
            this.filter = filter;
            this.order = order;
            this.limitVal = limitVal;
        }

        async get() {
            const queries = [];
            
            if (this.filter) {
                // Преобразуем фильтр в формат Appwrite
                let queryOp;
                switch (this.filter.operator) {
                    case '==':
                        queryOp = 'equal';
                        break;
                    case '>':
                        queryOp = 'greaterThan';
                        break;
                    case '>=':
                        queryOp = 'greaterThanEqual';
                        break;
                    case '<':
                        queryOp = 'lessThan';
                        break;
                    case '<=':
                        queryOp = 'lessThanEqual';
                        break;
                    default:
                        queryOp = 'equal';
                }
                queries.push(queryOp + '(' + this.filter.field + ', [' + JSON.stringify(this.filter.value) + '])');
            }
            
            if (this.order) {
                const orderType = this.order.direction.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
                queries.push('order' + orderType + '(' + this.order.field + ')');
            }
            
            if (this.limitVal) {
                queries.push('limit(' + this.limitVal + ')');
            }
            
            const documents = await AppwriteClient.databases.listDocuments(
                AppwriteClient.databaseId,
                this.collectionRef.collectionId,
                queries
            );
            
            return new QuerySnapshot(documents.documents.map(doc => new DocumentSnapshot(doc.$id, true, doc)));
        }

        onSnapshot(callback) {
            // Используем ту же реализацию, что и у CollectionReference
            const channel = `databases.${AppwriteClient.databaseId}.collections.${this.collectionRef.collectionId}.documents`;
            return AppwriteClient.realtime.subscribe(channel, response => {
                // Проверяем, соответствует ли документ нашим фильтрам
                if (this.filter) {
                    const docValue = response.payload[this.filter.field];
                    let matches = false;
                    
                    switch (this.filter.operator) {
                        case '==':
                            matches = docValue === this.filter.value;
                            break;
                        case '>':
                            matches = docValue > this.filter.value;
                            break;
                        case '>=':
                            matches = docValue >= this.filter.value;
                            break;
                        case '<':
                            matches = docValue < this.filter.value;
                            break;
                        case '<=':
                            matches = docValue <= this.filter.value;
                            break;
                    }
                    
                    if (!matches) return;
                }
                
                const document = new DocumentSnapshot(response.payload.$id, true, response.payload);
                const change = {
                    type: response.events.some(e => e.includes('create')) ? 'added' :
                          response.events.some(e => e.includes('update')) ? 'modified' : 'removed',
                    doc: document
                };
                
                const snapshot = {
                    docChanges: () => [change],
                    forEach: (fn) => fn(document)
                };
                
                callback(snapshot);
            });
        }
    }

    // Класс DocumentSnapshot
    class DocumentSnapshot {
        constructor(id, exists, data) {
            this.id = id;
            this.exists = exists;
            this._data = data;
        }

        data() {
            if (!this._data) return null;
            
            // Преобразуем даты обратно из строк
            const result = {};
            for (const [key, value] of Object.entries(this._data)) {
                if (typeof value === 'string') {
                    // Проверяем, является ли строка датой ISO
                    const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
                    if (dateRegex.test(value)) {
                        result[key] = new Date(value);
                    } else {
                        result[key] = value;
                    }
                } else {
                    result[key] = value;
                }
            }
            return result;
        }

        get(fieldPath) {
            return this._data ? this._data[fieldPath] : undefined;
        }

        get ref() {
            // Возвращаем ссылку на документ, но это требует знания родительской коллекции
            // В целях совместимости просто вернем null
            return null;
        }
    }

    // Класс QuerySnapshot
    class QuerySnapshot {
        constructor(documents) {
            this.docs = documents;
            this.empty = documents.length === 0;
            this.size = documents.length;
        }

        forEach(callback) {
            this.docs.forEach(callback);
        }

        docChanges() {
            // Возвращаем все документы как добавленные для простоты
            return this.docs.map(doc => ({
                type: 'added',
                doc: doc
            }));
        }
    }

    // Возвращаем объект с совместимым API
    return {
        collection: (collectionId) => new CollectionReference(`collections/${collectionId}/documents`, collectionId),
        fieldValue: {
            serverTimestamp: FieldValue.serverTimestamp
        },
        enablePersistence: () => {
            console.log('Appwrite does not support client-side persistence like Firestore');
            return Promise.resolve();
        }
    };
})();